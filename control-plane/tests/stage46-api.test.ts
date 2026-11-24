import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import securityConfigDefault from '../../core/security/security-config.example.json' with { type: 'json' };
import type { SecurityConfig } from '../../core/security/index.ts';
import { createControlPlaneApp } from '../server/create-control-plane-app.ts';

const SYNTHETIC_MASTER_KEY = 'synthetic-stage46-master-key-do-not-reuse-32b';
const OWNER_PASS = 'TejauraStage46Pass!2026';

function makeClock(startIso = '2026-11-24T09:00:00.000Z') {
  let ms = new Date(startIso).getTime();
  return {
    now: () => new Date(ms),
    advanceMs: (delta: number) => {
      ms += delta;
    },
  };
}

function extractCookiesFromSetCookie(headers: string[]): string[] {
  return headers.map((header) => header.split(';')[0] ?? '').filter(Boolean);
}

async function startHarness() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejaura-stage46-api-'));
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
    environment: 'development',
    sandboxProvider: 'mock_sandbox_v1',
    allowSimulatedSandbox: true,
    maxConcurrentDelegationTasks: 2,
  });
  const server = http.createServer(bundle.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind API test server');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    bundle,
    stateDir,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      bundle.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

async function reqJson(
  url: string,
  init: RequestInit & {
    cookie?: string;
    extraHeaders?: Record<string, string>;
    omitCsrf?: boolean;
  } = {},
) {
  const headers: Record<string, string> = { ...(init.extraHeaders ?? {}) };
  if (init.method && init.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (!init.omitCsrf) headers['X-TEJAURA-CSRF'] = '1';
  }
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(url, { ...init, headers });
  const setCookie =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, setCookie, data };
}

async function setupOwner(baseUrl: string): Promise<string> {
  const setup = await reqJson(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    body: JSON.stringify({
      owner_id: 'owner_primary',
      username: 'stage46_owner',
      email: 'owner@tejaura.local',
      password: OWNER_PASS,
    }),
  });
  assert.equal(setup.status, 201);
  const login = await reqJson(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ identifier: 'stage46_owner', password: OWNER_PASS }),
  });
  assert.equal(login.status, 200);
  return extractCookiesFromSetCookie(login.setCookie)[0]!;
}

describe('TEJAURA Stage 4.6 — Multi-Agent API & Owner Control', () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  it('refuses simulated sandbox execution in production', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejaura-stage46-prod-'));
    try {
      assert.throws(
        () =>
          createControlPlaneApp({
            stateDir,
            masterKeyMaterial: SYNTHETIC_MASTER_KEY,
            securityConfig: securityConfigDefault as SecurityConfig,
            environment: 'production',
            sandboxProvider: 'mock_sandbox_v1',
            allowSimulatedSandbox: true,
          }),
        /isolated_container_v1/,
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('exposes Stage 4.6 owner APIs and runs an objective through approval and consolidation', async () => {
    const clock = makeClock();
    const h = await startHarness();
    cleanups.push(h.close);
    const cookie = await setupOwner(h.baseUrl);

    const unauth = await reqJson(`${h.baseUrl}/api/stage46/agents`);
    assert.equal(unauth.status, 401);

    const agents = await reqJson(`${h.baseUrl}/api/stage46/agents`, { cookie });
    assert.equal(agents.status, 200);
    assert.equal((agents.data.agents as unknown[]).length, 10);

    const sandbox = await reqJson(`${h.baseUrl}/api/stage46/sandbox`, { cookie });
    assert.equal(sandbox.status, 200);
    assert.equal(
      (sandbox.data.sandbox as Record<string, unknown>).selected_provider,
      'mock_sandbox_v1',
    );
    assert.equal(
      (sandbox.data.sandbox as Record<string, unknown>).os_isolated,
      false,
    );

    const invalid = await reqJson(`${h.baseUrl}/api/stage46/projects`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'x', objective: 'short' }),
    });
    assert.equal(invalid.status, 400);

    const production = await reqJson(`${h.baseUrl}/api/stage46/projects`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Production objective',
        objective: 'Attempt to run a production objective without approval.',
        environment: 'production',
      }),
    });
    assert.equal(production.status, 400);

    const created = await reqJson(`${h.baseUrl}/api/stage46/projects`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Stage 4.6 API project',
        objective:
          'Build a marketing website landing page, prepare SEO and content, and publish the announcement.',
        context: { brand: 'Tejaura' },
      }),
    });
    assert.equal(created.status, 201);
    const projectId = (created.data.project as Record<string, unknown>).project_id as string;
    const rootTaskId = (created.data.task as Record<string, unknown>).task_id as string;

    const process1 = await reqJson(`${h.baseUrl}/api/stage46/queue/process`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ limit: 20 }),
    });
    assert.equal(process1.status, 200);
    assert.ok(((process1.data.summary as Record<string, unknown>).processed as number) > 0);

    const tasks1 = await reqJson(
      `${h.baseUrl}/api/stage46/tasks?project_id=${encodeURIComponent(projectId)}&limit=100`,
      { cookie },
    );
    assert.equal(tasks1.status, 200);
    const content = (tasks1.data.tasks as Array<Record<string, unknown>>).find(
      (task) => task.agent_id === 'content_social',
    )!;
    assert.equal(content.status, 'WAITING_FOR_APPROVAL');
    const approvalId = content.approval_id as string;
    assert.ok(approvalId);

    const approval = await reqJson(`${h.baseUrl}/api/approvals/${approvalId}/decide`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        decision: 'approved',
        reason: 'Approved for manual publication package release.',
      }),
    });
    assert.equal(approval.status, 200);
    assert.equal(
      (approval.data.delegation_task as Record<string, unknown>).status,
      'QUEUED',
    );

    const process2 = await reqJson(`${h.baseUrl}/api/stage46/queue/process`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ limit: 20 }),
    });
    assert.equal(process2.status, 200);

    const detail = await reqJson(`${h.baseUrl}/api/stage46/tasks/${rootTaskId}`, { cookie });
    assert.equal(detail.status, 200);
    assert.equal((detail.data.task as Record<string, unknown>).status, 'COMPLETED');
    assert.ok((detail.data.events as unknown[]).length > 0);

    const projectDetail = await reqJson(
      `${h.baseUrl}/api/stage46/projects/${projectId}`,
      { cookie },
    );
    assert.equal(projectDetail.status, 200);
    const projectTasks = projectDetail.data.tasks as Array<Record<string, unknown>>;
    assert.ok(projectTasks.some((task) => task.agent_id === 'qa_reviewer'));
    assert.ok(projectTasks.some((task) => task.input && (task.input as Record<string, unknown>).mode === 'consolidate'));

    const metrics = await reqJson(`${h.baseUrl}/api/stage46/metrics`, { cookie });
    assert.equal(metrics.status, 200);
    assert.ok((metrics.data.metrics as Record<string, unknown>).total as number >= 8);

    const overview = await reqJson(`${h.baseUrl}/api/stage46/overview`, { cookie });
    assert.equal(overview.status, 200);
    assert.ok(Array.isArray(overview.data.agents));

    const csrfMissing = await reqJson(`${h.baseUrl}/api/stage46/projects`, {
      method: 'POST',
      cookie,
      extraHeaders: { 'Content-Type': 'application/json' },
      omitCsrf: true,
      body: JSON.stringify({
        name: 'CSRF project',
        objective: 'This request must be rejected without the CSRF header.',
      }),
    });
    assert.ok(csrfMissing.status === 403 || csrfMissing.status === 400);

    clock.advanceMs(1000);
  });

  it('cancels a queued delegation task tree and records the owner action', async () => {
    const h = await startHarness();
    cleanups.push(h.close);
    const cookie = await setupOwner(h.baseUrl);

    const created = await reqJson(`${h.baseUrl}/api/stage46/projects`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Cancellation project',
        objective: 'Create a small analytics baseline report for cancellation testing.',
      }),
    });
    assert.equal(created.status, 201);
    const projectId = (created.data.project as Record<string, unknown>).project_id as string;

    const processRoot = await reqJson(`${h.baseUrl}/api/stage46/queue/process`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ limit: 1 }),
    });
    assert.equal(processRoot.status, 200);

    const tasks = await reqJson(
      `${h.baseUrl}/api/stage46/tasks?project_id=${encodeURIComponent(projectId)}&limit=100`,
      { cookie },
    );
    const queuedChild = (tasks.data.tasks as Array<Record<string, unknown>>).find(
      (task) => task.status === 'QUEUED' || task.status === 'CREATED',
    )!;
    assert.ok(queuedChild);

    const cancel = await reqJson(
      `${h.baseUrl}/api/stage46/tasks/${String(queuedChild.task_id)}/cancel`,
      {
        method: 'POST',
        cookie,
        body: JSON.stringify({ reason: 'Owner cancelled this department task for testing.' }),
      },
    );
    assert.equal(cancel.status, 200);
    assert.ok((cancel.data.cancelled_count as number) >= 1);
  });
});
