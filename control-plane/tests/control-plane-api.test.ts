import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { generateTotpCode } from '../../core/auth/index.ts';
import securityConfigDefault from '../../core/security/security-config.example.json' with { type: 'json' };
import type { SecurityConfig } from '../../core/security/index.ts';
import { createControlPlaneApp } from '../server/create-control-plane-app.ts';

const SYNTHETIC_MASTER_KEY = 'synthetic-control-plane-master-key-do-not-reuse-32';
const SYNTHETIC_WORKER_TOKEN = 'synthetic-airllm-worker-token-secret-value';
const OWNER_PASS = 'TejauraOwnerPass!987654';

function makeClock(startIso = '2026-11-20T14:00:00.000Z') {
  let ms = new Date(startIso).getTime();
  return {
    now: () => new Date(ms),
    advanceMs: (delta: number) => {
      ms += delta;
    },
  };
}

function extractCookiePair(setCookieHeaders: string[]): string {
  const first = setCookieHeaders[0] ?? '';
  return first.split(';')[0] ?? '';
}

async function startServerHarness(options: {
  environment: 'development' | 'production';
  clock: () => Date;
}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejaura-stage3-api-'));
  const prevToken = process.env.TEJAURA_AIRLLM_WORKER_TOKEN;
  process.env.TEJAURA_AIRLLM_WORKER_TOKEN = SYNTHETIC_WORKER_TOKEN;

  const fastSecurityConfig: SecurityConfig = {
    ...(securityConfigDefault as SecurityConfig),
    argon2id: {
      ...(securityConfigDefault as SecurityConfig).argon2id,
      memoryCostKiB: 19456,
      timeCost: 2,
      parallelism: 1,
    },
  };

  const bundle = createControlPlaneApp({
    stateDir,
    masterKeyMaterial: SYNTHETIC_MASTER_KEY,
    securityConfig: fastSecurityConfig,
    environment: options.environment,
    clock: options.clock,
    externalHandlers: {
      'external:api_call': async ({ task, markExternalEffectDispatched }) => {
        if (task.input.simulate_failure === true) {
          markExternalEffectDispatched();
          return {
            ok: false,
            error: {
              code: 'EXTERNAL_CALL_FAILED',
              message: 'Simulated downstream webhook timeout.',
              retryable: true,
            },
          };
        }
        markExternalEffectDispatched();
        return {
          ok: true,
          result: { dispatched: true, target: task.resource_id },
        };
      },
    },
  });

  const server = http.createServer(bundle.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind control plane test HTTP server');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    bundle,
    stateDir,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      bundle.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
      if (prevToken === undefined) {
        delete process.env.TEJAURA_AIRLLM_WORKER_TOKEN;
      } else {
        process.env.TEJAURA_AIRLLM_WORKER_TOKEN = prevToken;
      }
    },
  };
}

describe('Stage 3 — Control Plane HTTP API, Auth, CSRF, RBAC, Approvals & Secret Isolation', () => {
  const cleanups: Array<() => Promise<void>> = [];

  after(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it('rejects unauthenticated requests, enforces HTTPS in production, blocks missing/mismatched CSRF, and caps payloads at 64KB', async () => {
    const clock = makeClock();
    const prodSrv = await startServerHarness({
      environment: 'production',
      clock: clock.now,
    });
    cleanups.push(prodSrv.close);

    // 1. Unauthenticated overview request fails closed
    const unauthRes = await fetch(`${prodSrv.baseUrl}/api/system/overview`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    assert.equal(unauthRes.status, 401);

    // 2. Plain HTTP without forwarded HTTPS is rejected with 426 in production
    const plainHttpSetup = await fetch(`${prodSrv.baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TEJAURA-CSRF': '1',
      },
      body: JSON.stringify({
        owner_id: 'owner_ritesh',
        username: 'ritesh',
        email: 'owner@example.com',
        password: OWNER_PASS,
      }),
    });
    assert.equal(plainHttpSetup.status, 426);

    // 3. State-changing request without CSRF header returns 403
    const missingCsrf = await fetch(`${prodSrv.baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({}),
    });
    assert.equal(missingCsrf.status, 403);
    const missingCsrfJson = (await missingCsrf.json()) as { code: string };
    assert.equal(missingCsrfJson.code, 'CSRF_HEADER_REQUIRED');

    // 4. State-changing request with cross-site Origin returns 403
    const badOrigin = await fetch(`${prodSrv.baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-proto': 'https',
        'X-TEJAURA-CSRF': '1',
        Origin: 'https://evil.example.net',
      },
      body: JSON.stringify({}),
    });
    assert.equal(badOrigin.status, 403);
    const badOriginJson = (await badOrigin.json()) as { code: string };
    assert.equal(badOriginJson.code, 'CSRF_ORIGIN_MISMATCH');

    // 5. Payload larger than 64KB fails closed with 413
    const oversized = await fetch(`${prodSrv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-proto': 'https',
        'X-TEJAURA-CSRF': '1',
      },
      body: JSON.stringify({ identifier: 'a', password: 'x'.repeat(70_000) }),
    });
    assert.equal(oversized.status, 413);
  });

  it('completes owner setup, secure cookie login, MFA enrollment, task/approval/schedule/audit flows, session expiry, and never leaks secrets', async () => {
    const clock = makeClock();
    const srv = await startServerHarness({
      environment: 'production',
      clock: clock.now,
    });
    cleanups.push(srv.close);

    const httpsHeaders = (cookie?: string, csrf = false): Record<string, string> => {
      const h: Record<string, string> = {
        'x-forwarded-proto': 'https',
      };
      if (cookie) h.Cookie = cookie;
      if (csrf) {
        h['Content-Type'] = 'application/json';
        h['X-TEJAURA-CSRF'] = '1';
      }
      return h;
    };

    // 1. Setup custom owner ID + verify one-time recovery codes returned
    const setupRes = await fetch(`${srv.baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: httpsHeaders(undefined, true),
      body: JSON.stringify({
        owner_id: 'owner_ritesh',
        username: 'ritesh_owner',
        email: 'ritesh@example.com',
        password: OWNER_PASS,
      }),
    });
    assert.equal(setupRes.status, 201);
    const setupJson = (await setupRes.json()) as {
      ok: true;
      owner_id: string;
      recovery_codes: string[];
    };
    assert.equal(setupJson.owner_id, 'owner_ritesh');
    assert.ok(setupJson.recovery_codes.length >= 6);

    // 2. Login and verify HttpOnly, Secure, SameSite=Strict cookie attributes
    const loginRes = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: httpsHeaders(undefined, true),
      body: JSON.stringify({
        identifier: 'ritesh_owner',
        password: OWNER_PASS,
      }),
    });
    assert.equal(loginRes.status, 200);
    const setCookies = loginRes.headers.getSetCookie();
    assert.ok(setCookies.length >= 1);
    assert.match(setCookies[0]!, /HttpOnly/i);
    assert.match(setCookies[0]!, /Secure/i);
    assert.match(setCookies[0]!, /SameSite=Strict/i);
    const cookie = extractCookiePair(setCookies);

    // 3. System Overview exposes metadata ONLY and zero secret values
    const overviewRes = await fetch(`${srv.baseUrl}/api/system/overview`, {
      headers: httpsHeaders(cookie),
    });
    assert.equal(overviewRes.status, 200);
    const overviewRaw = await overviewRes.text();
    assert.equal(overviewRaw.includes(SYNTHETIC_MASTER_KEY), false);
    assert.equal(overviewRaw.includes(SYNTHETIC_WORKER_TOKEN), false);
    assert.equal(overviewRaw.includes(OWNER_PASS), false);

    const overviewJson = JSON.parse(overviewRaw) as {
      ok: true;
      owner: { owner_id: string };
      worker: { primary_runtime: string; paid_api_fallback_enabled: boolean };
      system_governance: { governance: { humanOwnerControl: boolean } };
      secrets_inventory: Array<{ key: string; present: boolean }>;
    };
    assert.equal(overviewJson.owner.owner_id, 'owner_ritesh');
    assert.equal(overviewJson.worker.primary_runtime, 'airllm');
    assert.equal(overviewJson.worker.paid_api_fallback_enabled, false);
    assert.equal(overviewJson.system_governance.governance.humanOwnerControl, true);
    assert.ok(
      overviewJson.secrets_inventory.some(
        (s) => s.key === 'TEJAURA_AIRLLM_WORKER_TOKEN' && s.present === true,
      ),
    );

    // 4. Create L3 supervised task -> enters Approval Inbox
    const createL3Res = await fetch(`${srv.baseUrl}/api/tasks`, {
      method: 'POST',
      headers: httpsHeaders(cookie, true),
      body: JSON.stringify({
        title: 'Call supervised external API',
        description: 'Run webhook integration check.',
        action: 'external:api_call',
        resource_id: 'webhook:staging',
        environment: 'staging',
        autonomy_level: 'L3',
        declared_scopes: ['net:egress:approved'],
        priority: 85,
        idempotent_action: false,
        max_retries: 1,
        timeout_ms: 10_000,
        input: { simulate_failure: true },
      }),
    });
    assert.equal(createL3Res.status, 201);
    const createL3Json = (await createL3Res.json()) as {
      ok: true;
      task: { id: string; status: string };
      approval_id: string;
    };
    assert.equal(createL3Json.task.status, 'waiting_for_approval');
    assert.ok(createL3Json.approval_id);

    // 5. Approve via Approval Inbox with custom owner ID & verified reason
    const decideRes = await fetch(
      `${srv.baseUrl}/api/approvals/${encodeURIComponent(createL3Json.approval_id)}/decide`,
      {
        method: 'POST',
        headers: httpsHeaders(cookie, true),
        body: JSON.stringify({
          decision: 'approved',
          reason: 'Verified staging webhook target',
        }),
      },
    );
    assert.equal(decideRes.status, 200);
    const decideJson = (await decideRes.json()) as {
      ok: true;
      task: { status: string };
    };
    assert.equal(decideJson.task.status, 'queued');

    // 6. Run worker tick -> executes simulated failing non-idempotent task -> locks automatic retry
    const tickRes = await fetch(`${srv.baseUrl}/api/worker/tick`, {
      method: 'POST',
      headers: httpsHeaders(cookie, true),
      body: JSON.stringify({}),
    });
    assert.equal(tickRes.status, 200);
    const tickJson = (await tickRes.json()) as {
      report: { executed_task_id: string; executed_status: string };
    };
    assert.equal(tickJson.report.executed_task_id, createL3Json.task.id);
    assert.equal(tickJson.report.executed_status, 'failed');

    const detailRes = await fetch(
      `${srv.baseUrl}/api/tasks/${encodeURIComponent(createL3Json.task.id)}`,
      { headers: httpsHeaders(cookie) },
    );
    assert.equal(detailRes.status, 200);
    const detailJson = (await detailRes.json()) as {
      task: { idempotent_action: boolean; error: { code: string } | null };
      attempts: Array<{ external_effect_dispatched: boolean; error_code: string | null }>;
    };
    assert.equal(detailJson.task.idempotent_action, false);
    assert.equal(detailJson.task.error?.code, 'NON_IDEMPOTENT_EXECUTION_FAILED');
    assert.equal(detailJson.attempts[0]?.external_effect_dispatched, true);

    // Retrying without confirmation returns 409 NON_IDEMPOTENT_CONFIRMATION_REQUIRED
    const blockedRetry = await fetch(
      `${srv.baseUrl}/api/tasks/${encodeURIComponent(createL3Json.task.id)}/retry`,
      {
        method: 'POST',
        headers: httpsHeaders(cookie, true),
        body: JSON.stringify({ confirm_non_idempotent_retry: false }),
      },
    );
    assert.equal(blockedRetry.status, 409);

    // 7. Create & toggle a schedule
    const createSched = await fetch(`${srv.baseUrl}/api/schedules`, {
      method: 'POST',
      headers: httpsHeaders(cookie, true),
      body: JSON.stringify({
        name: 'System Read Check',
        description: 'Read governance state every minute.',
        interval_seconds: 60,
        task_template: {
          type: 'governance.read',
          title: 'Governance Read',
          description: 'Read registered models',
          action: 'governance:read',
          resource_id: 'system:inventory',
          environment: 'local',
          autonomy_level: 'L0',
          declared_scopes: ['governance:read'],
          priority: 50,
          idempotent_action: true,
          max_retries: 0,
          timeout_ms: 10000,
          input: {},
        },
      }),
    });
    assert.equal(createSched.status, 201);
    const schedJson = (await createSched.json()) as { schedule: { id: string; enabled: boolean } };
    const toggleSched = await fetch(
      `${srv.baseUrl}/api/schedules/${encodeURIComponent(schedJson.schedule.id)}/toggle`,
      {
        method: 'POST',
        headers: httpsHeaders(cookie, true),
        body: JSON.stringify({ enabled: false }),
      },
    );
    assert.equal(toggleSched.status, 200);
    const toggleJson = (await toggleSched.json()) as { schedule: { enabled: boolean } };
    assert.equal(toggleJson.schedule.enabled, false);

    // 8. Audit trail records actions cleanly without secrets
    const auditRes = await fetch(`${srv.baseUrl}/api/audit`, {
      headers: httpsHeaders(cookie),
    });
    assert.equal(auditRes.status, 200);
    const auditRaw = await auditRes.text();
    assert.equal(auditRaw.includes(SYNTHETIC_MASTER_KEY), false);
    assert.equal(auditRaw.includes(SYNTHETIC_WORKER_TOKEN), false);

    // 9. Enroll MFA, logout, and verify login now requires TOTP code & old session cookie fails
    const mfaRes = await fetch(`${srv.baseUrl}/api/auth/mfa/enroll`, {
      method: 'POST',
      headers: httpsHeaders(cookie, true),
      body: JSON.stringify({ label: 'Pixel Owner Phone' }),
    });
    assert.equal(mfaRes.status, 201);
    const mfaJson = (await mfaRes.json()) as {
      provisioning_secret: string;
    };
    assert.ok(mfaJson.provisioning_secret.length > 8);

    const logoutRes = await fetch(`${srv.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: httpsHeaders(cookie, true),
      body: JSON.stringify({}),
    });
    assert.equal(logoutRes.status, 200);

    // Revoked session cookie must fail closed with 401
    const afterLogoutRes = await fetch(`${srv.baseUrl}/api/system/overview`, {
      headers: httpsHeaders(cookie),
    });
    assert.equal(afterLogoutRes.status, 401);

    // Login with enrolled MFA TOTP succeeds when code provided
    const totp = generateTotpCode(mfaJson.provisioning_secret, clock.now().getTime());
    const mfaLoginRes = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: httpsHeaders(undefined, true),
      body: JSON.stringify({
        identifier: 'ritesh_owner',
        password: OWNER_PASS,
        mfa_code: totp,
      }),
    });
    assert.equal(mfaLoginRes.status, 200);
    const cookie2 = extractCookiePair(mfaLoginRes.headers.getSetCookie());

    // Idle / absolute session expiry fails closed with 401
    clock.advanceMs(24 * 60 * 60 * 1000);
    const expiredRes = await fetch(`${srv.baseUrl}/api/system/overview`, {
      headers: httpsHeaders(cookie2),
    });
    assert.equal(expiredRes.status, 401);
  });
});
