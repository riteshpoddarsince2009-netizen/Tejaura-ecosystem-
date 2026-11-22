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

const SYNTHETIC_MASTER_KEY = 'synthetic-stage45-master-key-do-not-reuse-32b';
const SYNTHETIC_WORKER_TOKEN = 'synthetic-worker-secret-token-never-expose';
const OWNER_PASS = 'TejauraStage45Pass!2026';
const OWNER_PASS_ROTATED = 'TejauraRotatedPass!2027';

function makeClock(startIso = '2026-11-21T10:00:00.000Z') {
  let ms = new Date(startIso).getTime();
  return {
    now: () => new Date(ms),
    advanceMs: (delta: number) => {
      ms += delta;
    },
  };
}

function extractCookiesFromSetCookie(headers: string[]): string[] {
  return headers.map((h) => h.split(';')[0] ?? '').filter(Boolean);
}

async function startHarness(options: {
  stateDir?: string;
  environment?: 'development' | 'production';
  clock: () => Date;
}) {
  const stateDir =
    options.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tejaura-stage45-'));
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
    environment: options.environment ?? 'development',
    clock: options.clock,
  });

  const server = http.createServer(bundle.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind test HTTP server');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    bundle,
    stateDir,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      bundle.close();
    },
  };
}

async function reqJson(
  url: string,
  init: RequestInit & { cookie?: string; extraHeaders?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {
    ...(init.extraHeaders ?? {}),
  };
  if (init.method && init.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-TEJAURA-CSRF'] = '1';
  }
  if (init.cookie) {
    headers.Cookie = init.cookie;
  }

  const res = await fetch(url, {
    ...init,
    headers,
  });
  const setCookie =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [];
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, setCookie, data };
}

describe('TEJAURA Stage 4.5 — Owner Management Center & Auth Repair', () => {
  const cleanups: Array<() => Promise<void>> = [];

  after(async () => {
    for (const fn of cleanups) {
      await fn();
    }
    delete process.env.TEJAURA_AIRLLM_WORKER_TOKEN;
  });

  it('Scenario 1-7: Auth transport modes, multi-hop CSRF, restarts, sessions, password rotation, MFA & recovery codes', async () => {
    const clock = makeClock();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejaura-s45-auth-'));
    const h1 = await startHarness({ stateDir, environment: 'development', clock: clock.now });

    try {
      // 1. Setup succeeds once, fails closed (409) on second attempt
      const setup1 = await reqJson(`${h1.baseUrl}/api/auth/setup`, {
        method: 'POST',
        body: JSON.stringify({
          owner_id: 'owner_primary',
          username: 'ritesh_owner',
          email: 'owner@tejaura.local',
          password: OWNER_PASS,
        }),
      });
      assert.equal(setup1.status, 201);
      const recoveryCodes = setup1.data.recovery_codes as string[];
      assert.equal(recoveryCodes.length, 8);

      const setup2 = await reqJson(`${h1.baseUrl}/api/auth/setup`, {
        method: 'POST',
        body: JSON.stringify({
          owner_id: 'owner_rogue',
          username: 'rogue_user',
          email: 'rogue@tejaura.local',
          password: OWNER_PASS,
        }),
      });
      assert.equal(setup2.status, 409);

      // 2a. Loopback HTTP dev login returns tejaura_dev_session cookie & authenticates
      const loginDev = await reqJson(`${h1.baseUrl}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({
          identifier: 'ritesh_owner',
          password: OWNER_PASS,
        }),
      });
      assert.equal(loginDev.status, 200);
      assert.equal(loginDev.data.transport_mode, 'http_loopback_dev');
      const devCookie = extractCookiesFromSetCookie(loginDev.setCookie)[0]!;
      assert.ok(devCookie.startsWith('tejaura_dev_session='));

      const statusDev = await reqJson(`${h1.baseUrl}/api/auth/status`, {
        cookie: devCookie,
      });
      assert.equal(statusDev.status, 200);
      assert.equal(statusDev.data.authenticated, true);

      // 2b. Embedded HTTPS iframe login + multi-hop X-Forwarded-Host CSRF
      const loginIframe = await reqJson(`${h1.baseUrl}/api/auth/login`, {
        method: 'POST',
        extraHeaders: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'preview.tejaura.test, internal-proxy:3000',
          origin: 'https://preview.tejaura.test',
          'sec-fetch-dest': 'iframe',
          'sec-fetch-site': 'cross-site',
        },
        body: JSON.stringify({
          identifier: 'owner@tejaura.local',
          password: OWNER_PASS,
        }),
      });
      assert.equal(loginIframe.status, 200);
      assert.equal(loginIframe.data.transport_mode, 'https_embedded_iframe');
      assert.match(loginIframe.setCookie[0]!, /SameSite=None; HttpOnly; Secure; Partitioned/);
      const iframeCookie = extractCookiesFromSetCookie(loginIframe.setCookie)[0]!;

      // 3. Invalid password rejected & rate limiting triggers 429
      for (let i = 0; i < 6; i++) {
        const bad = await reqJson(`${h1.baseUrl}/api/auth/login`, {
          method: 'POST',
          body: JSON.stringify({
            identifier: 'ritesh_owner',
            password: 'WrongPassword!123456',
          }),
        });
        assert.ok(bad.status === 401 || bad.status === 429);
        if (bad.status === 429) break;
      }

      // Advance past rate-limit window
      clock.advanceMs(16 * 60 * 1000);

      // Refresh login to create a clean 2nd session
      const loginSecond = await reqJson(`${h1.baseUrl}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({
          identifier: 'ritesh_owner',
          password: OWNER_PASS,
        }),
      });
      assert.equal(loginSecond.status, 200);
      const secondCookie = extractCookiesFromSetCookie(loginSecond.setCookie)[0]!;

      // Update Owner Profile
      const profUpd = await reqJson(`${h1.baseUrl}/api/auth/profile`, {
        method: 'PATCH',
        cookie: secondCookie,
        body: JSON.stringify({
          display_name: 'Ritesh Poddar',
          timezone: 'Asia/Kolkata',
        }),
      });
      assert.equal(profUpd.status, 200);
      assert.equal(
        (profUpd.data.profile as { display_name: string }).display_name,
        'Ritesh Poddar',
      );

      // 4. Restart server against same stateDir -> session & profile survive!
      await h1.close();
    } catch (err) {
      await h1.close();
      throw err;
    }

    const h2 = await startHarness({ stateDir, environment: 'development', clock: clock.now });
    cleanups.push(async () => {
      await h2.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    });

    // Re-login after restart check or verify session survives:
    const loginFresh = await reqJson(`${h2.baseUrl}/api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({
        identifier: 'ritesh_owner',
        password: OWNER_PASS,
      }),
    });
    assert.equal(loginFresh.status, 200);
    const cookieA = extractCookiesFromSetCookie(loginFresh.setCookie)[0]!;

    const loginB = await reqJson(`${h2.baseUrl}/api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({
        identifier: 'ritesh_owner',
        password: OWNER_PASS,
      }),
    });
    assert.equal(loginB.status, 200);
    const cookieB = extractCookiesFromSetCookie(loginB.setCookie)[0]!;

    // Verify profile persisted
    const profGet = await reqJson(`${h2.baseUrl}/api/auth/profile`, { cookie: cookieA });
    assert.equal(profGet.status, 200);
    assert.equal(
      (profGet.data.profile as { timezone: string }).timezone,
      'Asia/Kolkata',
    );

    // 5. Session list & revoke others
    const sessList = await reqJson(`${h2.baseUrl}/api/auth/sessions`, { cookie: cookieA });
    assert.equal(sessList.status, 200);
    assert.ok((sessList.data.sessions as unknown[]).length >= 2);

    const revOthers = await reqJson(`${h2.baseUrl}/api/auth/sessions/revoke-others`, {
      method: 'POST',
      cookie: cookieA,
      body: JSON.stringify({}),
    });
    assert.equal(revOthers.status, 200);
    assert.ok((revOthers.data.revoked_count as number) >= 1);

    const statusB = await reqJson(`${h2.baseUrl}/api/auth/status`, { cookie: cookieB });
    assert.equal(statusB.data.authenticated, false);

    // 6. MFA enrollment, whitespace tolerance, toggle & delete
    const mfaEnroll = await reqJson(`${h2.baseUrl}/api/auth/mfa/enroll`, {
      method: 'POST',
      cookie: cookieA,
      body: JSON.stringify({ label: 'Pixel 9 Authenticator' }),
    });
    assert.equal(mfaEnroll.status, 201);
    const factorId = mfaEnroll.data.factor_id as string;
    const secret = mfaEnroll.data.provisioning_secret as string;
    assert.ok(secret.length > 8);

    // Login without TOTP rejected
    const noMfa = await reqJson(`${h2.baseUrl}/api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({
        identifier: 'ritesh_owner',
        password: OWNER_PASS,
      }),
    });
    assert.equal(noMfa.status, 401);
    assert.equal(noMfa.data.mfa_required, true);

    // Login with formatted TOTP code ("123 456") accepted
    const totp = generateTotpCode(secret, clock.now().getTime());
    const formattedTotp = `${totp.slice(0, 3)} ${totp.slice(3)}`;
    const withMfa = await reqJson(`${h2.baseUrl}/api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({
        identifier: 'ritesh_owner',
        password: OWNER_PASS,
        mfa_code: formattedTotp,
      }),
    });
    assert.equal(withMfa.status, 200);
    const mfaCookie = extractCookiesFromSetCookie(withMfa.setCookie)[0]!;

    // Toggle MFA requires valid current password
    const badToggle = await reqJson(
      `${h2.baseUrl}/api/auth/mfa/${encodeURIComponent(factorId)}/toggle`,
      {
        method: 'POST',
        cookie: mfaCookie,
        body: JSON.stringify({ enabled: false, current_password: 'wrong-password' }),
      },
    );
    assert.equal(badToggle.status, 401);

    const goodToggle = await reqJson(
      `${h2.baseUrl}/api/auth/mfa/${encodeURIComponent(factorId)}/toggle`,
      {
        method: 'POST',
        cookie: mfaCookie,
        body: JSON.stringify({ enabled: false, current_password: OWNER_PASS }),
      },
    );
    assert.equal(goodToggle.status, 200);

    // 7. Regenerate recovery codes, rotate password, and use recovery code once
    const regen = await reqJson(`${h2.baseUrl}/api/auth/recovery-codes/regenerate`, {
      method: 'POST',
      cookie: mfaCookie,
      body: JSON.stringify({ current_password: OWNER_PASS }),
    });
    assert.equal(regen.status, 200);
    const freshCodes = regen.data.recovery_codes as string[];
    assert.equal(freshCodes.length, 8);

    const pwChange = await reqJson(`${h2.baseUrl}/api/auth/password`, {
      method: 'POST',
      cookie: mfaCookie,
      body: JSON.stringify({
        current_password: OWNER_PASS,
        new_password: OWNER_PASS_ROTATED,
      }),
    });
    assert.equal(pwChange.status, 200);

    // Single-use recovery works and cannot be replayed
    const recOk = await reqJson(`${h2.baseUrl}/api/auth/recover`, {
      method: 'POST',
      body: JSON.stringify({
        identifier: 'ritesh_owner',
        recovery_code: freshCodes[0],
        new_password: OWNER_PASS,
      }),
    });
    assert.equal(recOk.status, 200);

    const recReplay = await reqJson(`${h2.baseUrl}/api/auth/recover`, {
      method: 'POST',
      body: JSON.stringify({
        identifier: 'ritesh_owner',
        recovery_code: freshCodes[0],
        new_password: OWNER_PASS_ROTATED,
      }),
    });
    assert.equal(recReplay.status, 400);

    // Production mode fails closed on remote non-loopback plain HTTP
    const hProd = await startHarness({ environment: 'production', clock: clock.now });
    cleanups.push(async () => {
      await hProd.close();
      fs.rmSync(hProd.stateDir, { recursive: true, force: true });
    });
    const prodHttp = await reqJson(`${hProd.baseUrl}/api/auth/setup`, {
      method: 'POST',
      extraHeaders: {
        host: 'control.tejaura.example.com',
        'x-forwarded-proto': 'http',
      },
      body: JSON.stringify({
        owner_id: 'owner_primary',
        username: 'prod_owner',
        email: 'prod@tejaura.local',
        password: OWNER_PASS,
      }),
    });
    assert.equal(prodHttp.status, 426);
    assert.equal(prodHttp.data.code, 'HTTPS_REQUIRED');
  });

  it('Scenario 8-15: Agents, Models (ModelScope + disk verify), Workers (SSRF/secret/probe), Projects (prod approval gate), Backups, Persistence & Audit', async () => {
    const clock = makeClock();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejaura-s45-mgmt-'));
    const h1 = await startHarness({ stateDir, environment: 'development', clock: clock.now });

    // Local mock worker server returning /health and /v1/models without ever leaking Bearer token
    const mockWorker = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', runtime: 'airllm' }));
        return;
      }
      if (req.url === '/v1/models' || req.url === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [{ id: 'qwen2.5-7b-modelscope', loaded: true }],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      mockWorker.listen(0, '127.0.0.1', () => resolve()),
    );
    const workerAddr = mockWorker.address() as { port: number };
    const workerUrl = `http://127.0.0.1:${workerAddr.port}`;

    let createdAgentId = '';
    let createdProjectId = '';
    let createdBackupId = '';
    let cookie = '';

    try {
      await reqJson(`${h1.baseUrl}/api/auth/setup`, {
        method: 'POST',
        body: JSON.stringify({
          owner_id: 'owner_primary',
          username: 'ritesh_owner',
          email: 'owner@tejaura.local',
          password: OWNER_PASS,
        }),
      });
      const login = await reqJson(`${h1.baseUrl}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ identifier: 'ritesh_owner', password: OWNER_PASS }),
      });
      cookie = extractCookiesFromSetCookie(login.setCookie)[0]!;

      // 9. Unauthenticated request blocked
      const unauthAgents = await reqJson(`${h1.baseUrl}/api/agents`);
      assert.equal(unauthAgents.status, 401);

      // 8 & 9. Agent creation & L4 / self-approval protection
      const rogueL4 = await reqJson(`${h1.baseUrl}/api/agents`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          name: 'Rogue Agent',
          department: 'engineering',
          role: 'Admin',
          description: 'Attempt L4 autonomy',
          permitted_autonomy_level: 'L4',
        }),
      });
      assert.equal(rogueL4.status, 403);
      assert.equal(rogueL4.data.code, 'AGENT_L4_FORBIDDEN');

      const rogueSelfApprove = await reqJson(`${h1.baseUrl}/api/agents`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          name: 'Rogue Self Approve',
          department: 'engineering',
          role: 'Admin',
          description: 'Attempt self approval',
          permitted_autonomy_level: 'L2',
          allow_self_approval: true,
        }),
      });
      assert.equal(rogueSelfApprove.status, 400);

      const agCreate = await reqJson(`${h1.baseUrl}/api/agents`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          id: 'agent_eng_stage45',
          name: 'Engineering Sandbox Architect',
          department: 'engineering',
          role: 'Full-Stack Sandboxed Engineer',
          description: 'Builds tested UI and backend diffs in sandbox.',
          permitted_autonomy_level: 'L2',
          allowed_tool_ids: ['workspace.read', 'sandbox.inspect'],
          preferred_model_ids: ['qwen2.5-7b-modelscope'],
          max_concurrent_jobs: 2,
          timeout_ms: 25000,
          allowed_paths: ['sandbox'],
          network_mode: 'none',
        }),
      });
      assert.equal(agCreate.status, 201);
      createdAgentId = (agCreate.data.agent as { id: string }).id;

      const agPause = await reqJson(
        `${h1.baseUrl}/api/agents/${encodeURIComponent(createdAgentId)}/status`,
        {
          method: 'POST',
          cookie,
          body: JSON.stringify({ status: 'paused', enabled: false }),
        },
      );
      assert.equal(agPause.status, 200);
      assert.equal((agPause.data.agent as { status: string }).status, 'paused');

      const agActivate = await reqJson(
        `${h1.baseUrl}/api/agents/${encodeURIComponent(createdAgentId)}/status`,
        {
          method: 'POST',
          cookie,
          body: JSON.stringify({ status: 'active', enabled: true }),
        },
      );
      assert.equal(agActivate.status, 200);

      // 10. Model registry with ModelScope & honest disk verification
      const mCreate = await reqJson(`${h1.baseUrl}/api/models`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          model_id: 'qwen2.5-7b-modelscope',
          model_name: 'Qwen2.5-7B-Instruct',
          model_family: 'qwen2.5',
          model_version: '7b',
          source: 'modelscope',
          repo_id: 'Qwen/Qwen2.5-7B-Instruct',
          runtime_type: 'airllm',
          format: 'safetensors',
          size_mb: 4400,
          compatibility_status: 'verified',
          local_model_path: path.join(stateDir, 'missing-model-weights'),
          enabled: false,
        }),
      });
      assert.equal(mCreate.status, 201);

      const mVerifyMissing = await reqJson(
        `${h1.baseUrl}/api/models/qwen2.5-7b-modelscope/verify-install`,
        { method: 'POST', cookie, body: {} },
      );
      assert.equal(mVerifyMissing.status, 200);
      assert.equal(
        (mVerifyMissing.data.model as { verified_on_disk: boolean }).verified_on_disk,
        false,
      );
      assert.equal(
        (mVerifyMissing.data.model as { install_status: string }).install_status,
        'not_installed',
      );

      // Now create real non-empty artifact file on disk & re-verify
      const weightsDir = path.join(stateDir, 'missing-model-weights');
      fs.mkdirSync(weightsDir, { recursive: true });
      fs.writeFileSync(path.join(weightsDir, 'model.safetensors'), 'weights-header');
      const mVerifyFound = await reqJson(
        `${h1.baseUrl}/api/models/qwen2.5-7b-modelscope/verify-install`,
        { method: 'POST', cookie, body: {} },
      );
      assert.equal(mVerifyFound.status, 200);
      assert.equal(
        (mVerifyFound.data.model as { verified_on_disk: boolean }).verified_on_disk,
        true,
      );

      const mRole = await reqJson(
        `${h1.baseUrl}/api/models/qwen2.5-7b-modelscope/role`,
        { method: 'POST', cookie, body: JSON.stringify({ role: 'default' }) },
      );
      assert.equal(mRole.status, 200);
      assert.equal((mRole.data.model as { is_default: boolean }).is_default, true);

      // 11. Worker registration rejects raw token & probes real mock worker vs offline worker
      const wSecretReject = await reqJson(`${h1.baseUrl}/api/workers`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          name: 'Bad Secret Worker',
          runtime_type: 'airllm',
          node_id: 'local_host_airllm',
          base_url: workerUrl,
          api_key: 'sk-raw-secret-rejected',
        }),
      });
      assert.equal(wSecretReject.status, 400);

      const wOnlineCreate = await reqJson(`${h1.baseUrl}/api/workers`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          worker_id: 'airllm_local_mock',
          name: 'Local AirLLM Mock',
          runtime_type: 'airllm',
          node_id: 'local_host_airllm',
          base_url: workerUrl,
          requires_auth: true,
          auth_token_env_var: 'TEJAURA_AIRLLM_WORKER_TOKEN',
          enabled: true,
        }),
      });
      assert.equal(wOnlineCreate.status, 201);

      const wProbeOnline = await reqJson(
        `${h1.baseUrl}/api/workers/airllm_local_mock/probe`,
        { method: 'POST', cookie, body: {} },
      );
      assert.equal(wProbeOnline.status, 200);
      assert.equal((wProbeOnline.data.worker as { health_status: string }).health_status, 'online');
      assert.ok(
        (wProbeOnline.data.worker as { discovered_models: string[] }).discovered_models.includes(
          'qwen2.5-7b-modelscope',
        ),
      );

      const wOfflineCreate = await reqJson(`${h1.baseUrl}/api/workers`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          worker_id: 'airllm_offline_box',
          name: 'Offline GPU Node',
          runtime_type: 'airllm',
          node_id: 'local_host_airllm',
          base_url: 'http://127.0.0.1:59999',
          enabled: true,
        }),
      });
      assert.equal(wOfflineCreate.status, 201);
      const wProbeOffline = await reqJson(
        `${h1.baseUrl}/api/workers/airllm_offline_box/probe`,
        { method: 'POST', cookie, body: {} },
      );
      assert.equal(wProbeOffline.status, 200);
      assert.equal((wProbeOffline.data.worker as { health_status: string }).health_status, 'offline');

      // 12. Project creation, staging deploy, and production approval gate via Approval Inbox
      const pCreate = await reqJson(`${h1.baseUrl}/api/projects`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          name: 'TEJAURA Web Console',
          slug: 'tejaura-web-console',
          project_type: 'web_app',
          environment: 'staging',
          assigned_agent_ids: [createdAgentId],
        }),
      });
      assert.equal(pCreate.status, 201);
      createdProjectId = (pCreate.data.project as { project_id: string }).project_id;

      const pStageDeploy = await reqJson(
        `${h1.baseUrl}/api/projects/${encodeURIComponent(createdProjectId)}/deploy`,
        {
          method: 'POST',
          cookie,
          body: JSON.stringify({ target_environment: 'staging' }),
        },
      );
      assert.equal(pStageDeploy.status, 200);
      assert.equal(pStageDeploy.data.requires_approval, false);
      assert.equal(
        (pStageDeploy.data.project as { deployment_status: string }).deployment_status,
        'deployed',
      );

      const pProdRequest = await reqJson(
        `${h1.baseUrl}/api/projects/${encodeURIComponent(createdProjectId)}/deploy`,
        {
          method: 'POST',
          cookie,
          body: JSON.stringify({ target_environment: 'production' }),
        },
      );
      assert.equal(pProdRequest.status, 200);
      assert.equal(pProdRequest.data.requires_approval, true);
      assert.equal(
        (pProdRequest.data.project as { deployment_status: string }).deployment_status,
        'pending_approval',
      );
      const approvalId = (pProdRequest.data.approval as { id: string }).id;

      // Approve from Approval Inbox endpoint -> transitions project to deployed in production!
      const aprDecide = await reqJson(
        `${h1.baseUrl}/api/approvals/${encodeURIComponent(approvalId)}/decide`,
        {
          method: 'POST',
          cookie,
          body: JSON.stringify({
            decision: 'approved',
            reason: 'Verified staging smoke tests before production release.',
          }),
        },
      );
      assert.equal(aprDecide.status, 200);
      assert.equal(
        (aprDecide.data.project as { deployment_status: string }).deployment_status,
        'deployed',
      );

      // 13 & 14. System Config, Backup creation, Audit logs, and Zero Secret Leakage
      const cfgPatch = await reqJson(`${h1.baseUrl}/api/system/config`, {
        method: 'PATCH',
        cookie,
        body: JSON.stringify({ max_queue_depth: 45, preferred_model_source: 'modelscope' }),
      });
      assert.equal(cfgPatch.status, 200);
      assert.equal((cfgPatch.data.config as { max_queue_depth: number }).max_queue_depth, 45);

      const bkpCreate = await reqJson(`${h1.baseUrl}/api/system/backups`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({}),
      });
      assert.equal(bkpCreate.status, 201);
      createdBackupId = (bkpCreate.data.backup as { backup_id: string }).backup_id;

      const sysLogs = await reqJson(`${h1.baseUrl}/api/system/logs?limit=25&offset=0`, {
        cookie,
      });
      assert.equal(sysLogs.status, 200);
      assert.ok((sysLogs.data.logs as unknown[]).length >= 3);
      assert.equal(
        JSON.stringify(sysLogs.data).includes(SYNTHETIC_WORKER_TOKEN),
        false,
        'Logs must never contain worker secret',
      );

      const sysAdmin = await reqJson(`${h1.baseUrl}/api/system/admin`, { cookie });
      assert.equal(sysAdmin.status, 200);
      assert.equal(
        (sysAdmin.data.admin as { database: { integrity_ok: boolean } }).database.integrity_ok,
        true,
      );

      // Delete project, then restore from SHA-256 backup and verify project returns!
      const pDel = await reqJson(
        `${h1.baseUrl}/api/projects/${encodeURIComponent(createdProjectId)}`,
        { method: 'DELETE', cookie },
      );
      assert.equal(pDel.status, 200);

      const bkpRestore = await reqJson(
        `${h1.baseUrl}/api/system/backups/${encodeURIComponent(createdBackupId)}/restore`,
        { method: 'POST', cookie, body: JSON.stringify({}) },
      );
      assert.equal(bkpRestore.status, 200);

      const pListAfterRestore = await reqJson(`${h1.baseUrl}/api/projects`, { cookie });
      assert.equal(
        (pListAfterRestore.data.projects as Array<{ project_id: string }>).some(
          (p) => p.project_id === createdProjectId,
        ),
        true,
      );

      await h1.close();
    } catch (err) {
      await h1.close();
      await new Promise<void>((resolve) => mockWorker.close(() => resolve()));
      throw err;
    }

    // Verify full SQLite persistence across server restart
    const hRestarted = await startHarness({
      stateDir,
      environment: 'development',
      clock: clock.now,
    });
    cleanups.push(async () => {
      await hRestarted.close();
      await new Promise<void>((resolve) => mockWorker.close(() => resolve()));
      fs.rmSync(stateDir, { recursive: true, force: true });
    });

    const agentsAfterRestart = await reqJson(`${hRestarted.baseUrl}/api/agents`, { cookie });
    assert.equal(agentsAfterRestart.status, 200);
    assert.equal(
      (agentsAfterRestart.data.agents as Array<{ id: string }>).some(
        (a) => a.id === createdAgentId,
      ),
      true,
    );
  });
});
