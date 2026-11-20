import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EncryptedFileIdentityStoreBackend,
  InMemoryIdentityStoreBackend,
  TejauraAuthService,
  buildSessionSetCookieHeader,
  generateTotpCode,
  parseSessionTokenFromCookieHeader,
} from '../auth/index.ts';
import { ApprovalService } from '../approvals/index.ts';
import { AuditLogger, InMemoryAuditStorage } from '../audit/index.ts';
import { evaluatePolicy } from '../policy/index.ts';
import systemConfig from '../configuration/system.json' with { type: 'json' };
import securityConfigExample from '../security/security-config.example.json' with { type: 'json' };
import {
  decryptAes256Gcm,
  deriveAes256Key,
  encryptAes256Gcm,
  enforceHttpsTransport,
  hashSecretArgon2id,
  validateSecurityConfig,
  verifySecretArgon2id,
} from '../security/index.ts';
import type { SecurityConfig } from '../security/index.ts';
import {
  AIRLLM_WORKER_TOKEN_ENV_VAR,
  EnvSecretProvider,
  SecretsManager,
} from '../secrets/index.ts';

const TEST_MASTER_KEY = 'synthetic-test-master-key-do-not-use-in-prod-32bytes';
const TEST_OWNER_PASS = 'OwnerSyntheticPass!98765';
const TEST_NEW_PASS = 'RotatedSyntheticPass!43210';

function createClock(startIso = '2026-03-01T12:00:00.000Z') {
  let currentMs = new Date(startIso).getTime();
  return {
    now: () => new Date(currentMs),
    advanceSeconds: (secs: number) => {
      currentMs += secs * 1000;
    },
  };
}

function makeAuthHarness(options?: {
  clock?: () => Date;
  workerToken?: string;
  configOverrides?: Partial<SecurityConfig>;
}) {
  const storage = new InMemoryAuditStorage();
  const auditLogger = new AuditLogger({
    storage,
    clock: options?.clock,
  });
  const envProvider = new EnvSecretProvider({
    env: options?.workerToken
      ? { [AIRLLM_WORKER_TOKEN_ENV_VAR]: options.workerToken }
      : {},
  });
  const secretsManager = new SecretsManager({
    masterKeyMaterial: TEST_MASTER_KEY,
    envProvider,
    auditLogger,
    clock: options?.clock,
  });

  const cfg: SecurityConfig = {
    ...(securityConfigExample as SecurityConfig),
    ...options?.configOverrides,
    // Use OWASP minimum 19 MiB in tests so Argon2id stays fast while remaining authentic Argon2id.
    argon2id: {
      memoryCostKiB: 19456,
      timeCost: 2,
      parallelism: 1,
      saltBytes: 16,
      hashLength: 32,
    },
  };

  const store = new InMemoryIdentityStoreBackend();
  const auth = new TejauraAuthService({
    securityConfig: cfg,
    masterKeyMaterial: TEST_MASTER_KEY,
    store,
    secretsManager,
    auditLogger,
    clock: options?.clock,
  });

  return { auth, store, auditLogger, storage, secretsManager, cfg };
}

test('SecurityConfig validator enforces schema, rejects secrets, and checks bounds', () => {
  const valid = validateSecurityConfig(securityConfigExample);
  assert.equal(valid.valid, true);

  const withSecret = {
    ...(securityConfigExample as Record<string, unknown>),
    password: 'synthetic-plaintext-password',
  };
  const badSecret = validateSecurityConfig(withSecret);
  assert.equal(badSecret.valid, false);

  const insecureCookie = {
    ...securityConfigExample,
    session: {
      ...securityConfigExample.session,
      httpOnly: false,
    },
  };
  assert.equal(validateSecurityConfig(insecureCookie).valid, false);

  const insecureHttps = {
    ...securityConfigExample,
    transport: {
      ...securityConfigExample.transport,
      enforceHttpsInDeployment: false,
    },
  };
  assert.equal(validateSecurityConfig(insecureHttps).valid, false);
});

test('Argon2id hashes use unique random salts and never store plaintext passwords', async () => {
  const params = {
    memoryCostKiB: 19456,
    timeCost: 2,
    parallelism: 1,
    saltBytes: 16,
    hashLength: 32,
  };

  const hashA = await hashSecretArgon2id(TEST_OWNER_PASS, params);
  const hashB = await hashSecretArgon2id(TEST_OWNER_PASS, params);

  assert.ok(hashA.startsWith('$argon2id$'));
  assert.ok(hashB.startsWith('$argon2id$'));
  assert.notEqual(hashA, hashB, 'Unique random salts must produce distinct hashes');
  assert.equal(hashA.includes(TEST_OWNER_PASS), false);

  assert.equal(await verifySecretArgon2id(TEST_OWNER_PASS, hashA), true);
  assert.equal(await verifySecretArgon2id('WrongPassword!1234', hashA), false);
});

test('AES-256-GCM encrypts sensitive stored data and fails closed on tampering', () => {
  const key = deriveAes256Key(TEST_MASTER_KEY, 'test-context');
  const envelope = encryptAes256Gcm('sensitive-totp-seed', key, 'aad-binding');

  assert.equal(envelope.alg, 'aes-256-gcm');
  assert.equal(envelope.ciphertext_b64.includes('sensitive-totp-seed'), false);

  const decrypted = decryptAes256Gcm(envelope, key, 'aad-binding');
  assert.equal(decrypted, 'sensitive-totp-seed');

  // Wrong AAD fails closed.
  assert.throws(() => decryptAes256Gcm(envelope, key, 'wrong-aad'));

  // Tampered tag fails closed.
  const tampered = {
    ...envelope,
    tag_b64: Buffer.alloc(16, 0xaa).toString('base64'),
  };
  assert.throws(() => decryptAes256Gcm(tampered, key, 'aad-binding'));
});

test('Initial owner setup succeeds once, hashes recovery codes, and rejects worker token confusion', async () => {
  const clock = createClock();
  const { auth, store, storage } = makeAuthHarness({
    clock: clock.now,
    workerToken: 'WorkerToken!Synthetic123',
  });

  // Weak password rejected.
  const weak = await auth.setupInitialOwner({
    owner_id: 'owner_primary',
    username: 'tejaura_owner',
    email: 'owner@example.test',
    password: 'short',
    correlation_id: 'corr_setup_weak',
  });
  assert.equal(weak.ok, false);

  // Password matching TEJAURA_AIRLLM_WORKER_TOKEN rejected.
  const confused = await auth.setupInitialOwner({
    owner_id: 'owner_primary',
    username: 'tejaura_owner',
    email: 'owner@example.test',
    password: 'WorkerToken!Synthetic123',
    correlation_id: 'corr_setup_worker_conflict',
  });
  assert.equal(confused.ok, false);
  if (!confused.ok) {
    assert.equal(confused.code, 'WORKER_TOKEN_PASSWORD_CONFLICT');
  }

  // Valid once-only setup.
  const setup = await auth.setupInitialOwner({
    owner_id: 'owner_primary',
    username: 'tejaura_owner',
    email: 'owner@example.test',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_setup_ok',
  });
  assert.equal(setup.ok, true);
  if (setup.ok) {
    assert.equal(setup.recovery_codes.length, 8);
  }

  // Stored snapshot contains zero plaintext passwords or recovery codes.
  const snapshotRaw = JSON.stringify(store.load());
  assert.equal(snapshotRaw.includes(TEST_OWNER_PASS), false);
  if (setup.ok) {
    for (const code of setup.recovery_codes) {
      assert.equal(snapshotRaw.includes(code), false);
    }
  }

  // Second setup attempt fails closed.
  const second = await auth.setupInitialOwner({
    owner_id: 'owner_attacker',
    username: 'attacker',
    email: 'attacker@example.test',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_setup_dup',
  });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.code, 'OWNER_ALREADY_INITIALIZED');
  }

  const events = storage.getEvents();
  assert.ok(events.some((e) => e.event_type === 'auth.setup.completed'));
  assert.ok(events.some((e) => e.event_type === 'auth.recovery.generated'));
});

test('Owner login supports username or email, sets HttpOnly/Secure/SameSite cookie, enforces expiry, logout, and revocation', async () => {
  const clock = createClock();
  const { auth, storage } = makeAuthHarness({ clock: clock.now });

  await auth.setupInitialOwner({
    owner_id: 'owner_primary',
    username: 'owner_admin',
    email: 'owner@tejaura.local',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_init',
  });

  // Login via email over HTTPS.
  const loginRes = await auth.login({
    identifier: 'owner@tejaura.local',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_login_email',
    request: {
      protocol: 'https',
      encrypted: true,
      host: 'control.tejaura.local',
      clientIp: '198.51.100.10',
      environment: 'production',
    },
  });
  assert.equal(loginRes.ok, true);
  if (!loginRes.ok) return;

  assert.match(loginRes.set_cookie_header, /^__Host-tejaura_session=/);
  assert.match(loginRes.set_cookie_header, /HttpOnly/);
  assert.match(loginRes.set_cookie_header, /Secure/);
  assert.match(loginRes.set_cookie_header, /SameSite=Strict/);
  assert.match(loginRes.set_cookie_header, /Path=\//);

  const token = parseSessionTokenFromCookieHeader(
    loginRes.set_cookie_header.split(';')[0],
    '__Host-tejaura_session',
  );
  assert.ok(token && token.length >= 32);

  // Verify session authentication.
  const cookieHeader = `__Host-tejaura_session=${encodeURIComponent(token)}`;
  const authCheck = auth.authenticateSessionFromCookieHeader(cookieHeader, {
    protocol: 'https',
    encrypted: true,
    environment: 'production',
  });
  assert.equal(authCheck.ok, true);

  // Verified session bridges cleanly into PolicyEvaluator L4 and ApprovalService.
  if (authCheck.ok) {
    const policyRes = evaluatePolicy({
      actor: authCheck.session.toPolicyActor(),
      action: 'deploy:production',
      resource: { id: 'prod-target', type: 'deployment' },
      environment: 'production',
      declared_scopes: ['deploy:production'],
      owner_confirmed_l4: true,
      system_config: systemConfig,
    });
    assert.equal(policyRes.allowed, true);

    const approvals = new ApprovalService({ designatedOwnerId: 'owner_primary' });
    const reqRes = approvals.requestApproval({
      task_id: 'task-101',
      action: 'external:api_call',
      requested_by: 'agent_planner',
      environment: 'local',
      reason: 'Call approved endpoint',
      scope: {
        resources: ['approved-endpoint'],
        permissions: ['net:egress:approved'],
        single_use: true,
      },
      correlation_id: 'corr_apr_req',
    });
    assert.equal(reqRes.ok, true);
    if (reqRes.ok) {
      const decRes = approvals.decideApproval({
        approval_id: reqRes.record.id,
        decision: 'approved',
        reviewer: authCheck.session.toTrustedReviewerContext(),
        reason: 'Verified owner session decision',
        correlation_id: 'corr_apr_dec',
      });
      assert.equal(decRes.ok, true);
    }
  }

  // Idle timeout expires session.
  clock.advanceSeconds(3601);
  const idleCheck = auth.authenticateSessionFromCookieHeader(cookieHeader);
  assert.equal(idleCheck.ok, false);
  if (!idleCheck.ok) {
    assert.equal(idleCheck.code, 'SESSION_IDLE_EXPIRED');
  }

  // Fresh login + explicit logout revokes session.
  const login2 = await auth.login({
    identifier: 'owner_admin',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_login_username',
  });
  assert.equal(login2.ok, true);
  if (!login2.ok) return;

  const cookie2 = login2.set_cookie_header.split(';')[0]!;
  const logoutRes = auth.logout({
    cookieHeader: cookie2,
    correlation_id: 'corr_logout',
  });
  assert.equal(logoutRes.ok, true);
  assert.match(logoutRes.clear_cookie_header, /Max-Age=0/);

  const afterLogout = auth.authenticateSessionFromCookieHeader(cookie2);
  assert.equal(afterLogout.ok, false);
  if (!afterLogout.ok) {
    assert.equal(afterLogout.code, 'SESSION_REVOKED');
  }

  // Login again and revoke via revokeSession.
  const login3 = await auth.login({
    identifier: 'owner_admin',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_login_3',
  });
  assert.equal(login3.ok, true);
  if (!login3.ok) return;

  const revokeRes = auth.revokeSession({
    principal: login3.session.toPrincipal(),
    target_session_id: login3.session.session_id,
    correlation_id: 'corr_revoke',
  });
  assert.equal(revokeRes.ok, true);

  const afterRevoke = auth.authenticateSessionFromCookieHeader(
    login3.set_cookie_header.split(';')[0]!,
  );
  assert.equal(afterRevoke.ok, false);

  const eventTypes = storage.getEvents().map((e) => e.event_type);
  assert.ok(eventTypes.includes('auth.login.succeeded'));
  assert.ok(eventTypes.includes('auth.logout'));
  assert.ok(eventTypes.includes('auth.session.revoked'));
});

test('Login rate limiter locks out brute force attempts and logs failed auth events', async () => {
  const clock = createClock();
  const { auth, storage } = makeAuthHarness({ clock: clock.now });

  await auth.setupInitialOwner({
    owner_id: 'owner_primary',
    username: 'owner_admin',
    email: 'owner@tejaura.local',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_init',
  });

  for (let i = 0; i < 4; i += 1) {
    const attempt = await auth.login({
      identifier: 'owner_admin',
      password: 'WrongPassword!000',
      correlation_id: `corr_fail_${i}`,
      request: {
        protocol: 'https',
        encrypted: true,
        clientIp: '203.0.113.42',
        environment: 'production',
      },
    });
    assert.equal(attempt.ok, false);
    if (!attempt.ok) {
      assert.equal(attempt.code, 'INVALID_CREDENTIALS');
    }
  }

  // 5th failure triggers lockout.
  const fifth = await auth.login({
    identifier: 'owner_admin',
    password: 'WrongPassword!000',
    correlation_id: 'corr_fail_5',
    request: {
      protocol: 'https',
      encrypted: true,
      clientIp: '203.0.113.42',
      environment: 'production',
    },
  });
  assert.equal(fifth.ok, false);
  if (!fifth.ok) {
    assert.equal(fifth.code, 'RATE_LIMITED');
  }

  // Even valid password fails while locked out.
  const lockedValid = await auth.login({
    identifier: 'owner_admin',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_locked_valid',
    request: {
      protocol: 'https',
      encrypted: true,
      clientIp: '203.0.113.42',
      environment: 'production',
    },
  });
  assert.equal(lockedValid.ok, false);
  if (!lockedValid.ok) {
    assert.equal(lockedValid.code, 'RATE_LIMITED');
  }

  // After lockout window expires, valid login succeeds.
  clock.advanceSeconds(901);
  const unlocked = await auth.login({
    identifier: 'owner_admin',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_unlocked',
    request: {
      protocol: 'https',
      encrypted: true,
      clientIp: '203.0.113.42',
      environment: 'production',
    },
  });
  assert.equal(unlocked.ok, true);

  const failedLogs = storage
    .getEvents()
    .filter((e) => e.event_type === 'auth.login.failed');
  assert.ok(failedLogs.length >= 5);
  // Ensure plaintext password never appears in audit log lines.
  assert.equal(storage.getLines().join('\n').includes(TEST_OWNER_PASS), false);
});

test('MFA (TOTP) and Passkey (WebAuthn ES256) extensible modules enforce verification and replay protection', async () => {
  const clock = createClock();
  const { auth } = makeAuthHarness({ clock: clock.now });

  await auth.setupInitialOwner({
    owner_id: 'owner_primary',
    username: 'owner_admin',
    email: 'owner@tejaura.local',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_init',
  });

  const initialLogin = await auth.login({
    identifier: 'owner_admin',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_login_1',
  });
  assert.equal(initialLogin.ok, true);
  if (!initialLogin.ok) return;

  // Enroll TOTP MFA.
  const totpEnroll = auth.enrollTotpMfa({
    principal: initialLogin.session.toPrincipal(),
    label: 'Owner Phone Authenticator',
    correlation_id: 'corr_mfa_enroll',
  });
  assert.equal(totpEnroll.ok, true);
  if (!totpEnroll.ok || !totpEnroll.provisioning_secret) return;

  // Password-only login now requires MFA.
  const noMfa = await auth.login({
    identifier: 'owner_admin',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_login_no_mfa',
  });
  assert.equal(noMfa.ok, false);
  if (!noMfa.ok) {
    assert.equal(noMfa.code, 'MFA_CODE_REQUIRED');
    assert.equal(noMfa.mfa_required, true);
  }

  // Valid TOTP succeeds.
  const totpCode = generateTotpCode(
    totpEnroll.provisioning_secret,
    clock.now().getTime(),
  );
  const withMfa = await auth.login({
    identifier: 'owner_admin',
    password: TEST_OWNER_PASS,
    mfa_code: totpCode,
    correlation_id: 'corr_login_with_mfa',
  });
  assert.equal(withMfa.ok, true);

  // Replaying the exact same TOTP code in the same 30s step fails!
  const replayMfa = await auth.login({
    identifier: 'owner_admin',
    password: TEST_OWNER_PASS,
    mfa_code: totpCode,
    correlation_id: 'corr_login_mfa_replay',
  });
  assert.equal(replayMfa.ok, false);

  // Register an ECDSA P-256 Passkey and verify real cryptographic WebAuthn assertion.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const credentialId = 'cred_synthetic_p256_01';

  const regRes = auth.registerPasskey({
    principal: initialLogin.session.toPrincipal(),
    credential_id: credentialId,
    label: 'Android Titan Passkey',
    algorithm: 'ES256',
    public_key_pem: publicKeyPem,
    correlation_id: 'corr_passkey_reg',
  });
  assert.equal(regRes.ok, true);

  const chRes = auth.issuePasskeyChallenge({
    correlation_id: 'corr_passkey_ch',
  });
  assert.equal(chRes.ok, true);
  if (!chRes.ok) return;

  const expectedOrigin = 'https://control.tejaura.local';
  const clientDataObj = {
    type: 'webauthn.get',
    challenge: chRes.challenge,
    origin: expectedOrigin,
  };
  const clientDataBytes = Buffer.from(JSON.stringify(clientDataObj), 'utf8');
  const rpIdHash = crypto
    .createHash('sha256')
    .update('control.tejaura.local', 'utf8')
    .digest();
  const flags = Buffer.from([0x01]); // UP bit set
  const signCount = Buffer.alloc(4);
  signCount.writeUInt32BE(1, 0);
  const authData = Buffer.concat([rpIdHash, flags, signCount]);
  const clientDataHash = crypto.createHash('sha256').update(clientDataBytes).digest();
  const sig = crypto.sign('sha256', Buffer.concat([authData, clientDataHash]), privateKey);

  const passkeyLogin = await auth.authenticatePasskey({
    assertion: {
      credential_id: credentialId,
      challenge: chRes.challenge,
      clientDataJSON_b64: clientDataBytes.toString('base64url'),
      authenticatorData_b64: authData.toString('base64url'),
      signature_b64: sig.toString('base64url'),
    },
    expectedOrigin,
    correlation_id: 'corr_passkey_auth',
  });
  assert.equal(passkeyLogin.ok, true);

  // Replaying the same challenge fails closed.
  const replayChallenge = await auth.authenticatePasskey({
    assertion: {
      credential_id: credentialId,
      challenge: chRes.challenge,
      clientDataJSON_b64: clientDataBytes.toString('base64url'),
      authenticatorData_b64: authData.toString('base64url'),
      signature_b64: sig.toString('base64url'),
    },
    expectedOrigin,
    correlation_id: 'corr_passkey_replay',
  });
  assert.equal(replayChallenge.ok, false);
});

test('Secure account recovery resets password with single-use code, revokes all sessions, and never exposes secrets', async () => {
  const clock = createClock();
  const { auth } = makeAuthHarness({ clock: clock.now });

  const setup = await auth.setupInitialOwner({
    owner_id: 'owner_primary',
    username: 'owner_admin',
    email: 'owner@tejaura.local',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_init',
  });
  assert.equal(setup.ok, true);
  if (!setup.ok) return;

  const loginRes = await auth.login({
    identifier: 'owner_admin',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_login',
  });
  assert.equal(loginRes.ok, true);
  if (!loginRes.ok) return;
  const activeCookie = loginRes.set_cookie_header.split(';')[0]!;

  const recoveryCode = setup.recovery_codes[0]!;
  const recRes = await auth.recoverAccount({
    identifier: 'owner_admin',
    recovery_code: recoveryCode,
    new_password: TEST_NEW_PASS,
    correlation_id: 'corr_recover',
  });
  assert.equal(recRes.ok, true);
  if (recRes.ok) {
    assert.equal(recRes.revoked_sessions, 1);
    assert.equal(recRes.remaining_recovery_codes, 7);
    assert.equal(JSON.stringify(recRes).includes(TEST_OWNER_PASS), false);
    assert.equal(JSON.stringify(recRes).includes(TEST_NEW_PASS), false);
  }

  // Old session is revoked immediately.
  const oldSessionCheck = auth.authenticateSessionFromCookieHeader(activeCookie);
  assert.equal(oldSessionCheck.ok, false);

  // Reusing consumed recovery code fails closed.
  const reuseRes = await auth.recoverAccount({
    identifier: 'owner_admin',
    recovery_code: recoveryCode,
    new_password: 'AnotherPassword!9999',
    correlation_id: 'corr_recover_reuse',
  });
  assert.equal(reuseRes.ok, false);

  // Old password rejected, new password succeeds.
  const oldPassLogin = await auth.login({
    identifier: 'owner_admin',
    password: TEST_OWNER_PASS,
    correlation_id: 'corr_old_pass',
  });
  assert.equal(oldPassLogin.ok, false);

  const newPassLogin = await auth.login({
    identifier: 'owner_admin',
    password: TEST_NEW_PASS,
    correlation_id: 'corr_new_pass',
  });
  assert.equal(newPassLogin.ok, true);
});

test('HTTPS transport enforcement blocks plaintext HTTP in deployment and allows encrypted/proxy HTTPS', () => {
  const transport = securityConfigExample.transport as SecurityConfig['transport'];

  const httpProd = enforceHttpsTransport(
    {
      protocol: 'http',
      encrypted: false,
      host: 'tejaura.example.com',
      environment: 'production',
    },
    transport,
  );
  assert.equal(httpProd.allowed, false);
  if (!httpProd.allowed) {
    assert.equal(httpProd.code, 'HTTPS_REQUIRED');
  }

  const httpLoopbackProd = enforceHttpsTransport(
    {
      protocol: 'http',
      encrypted: false,
      host: '127.0.0.1:3000',
      environment: 'production',
    },
    transport,
  );
  assert.equal(httpLoopbackProd.allowed, false, 'Production must always enforce HTTPS');

  const httpsProxy = enforceHttpsTransport(
    {
      protocol: 'http',
      encrypted: false,
      forwardedProto: 'https',
      host: 'tejaura.example.com',
      environment: 'production',
    },
    transport,
  );
  assert.equal(httpsProxy.allowed, true);

  const httpLoopbackDev = enforceHttpsTransport(
    {
      protocol: 'http',
      encrypted: false,
      host: '127.0.0.1:3000',
      environment: 'local',
    },
    transport,
  );
  assert.equal(httpLoopbackDev.allowed, true);
});

test('EncryptedFileIdentityStoreBackend encrypts persisted identity on disk and refuses public web dirs', async () => {
  assert.throws(
    () =>
      new EncryptedFileIdentityStoreBackend({
        stateDir: path.join(os.tmpdir(), 'src'),
        masterKeyMaterial: TEST_MASTER_KEY,
      }),
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejaura-id-store-'));
  try {
    const fileBackend = new EncryptedFileIdentityStoreBackend({
      stateDir: tmpDir,
      masterKeyMaterial: TEST_MASTER_KEY,
    });

    const auth = new TejauraAuthService({
      securityConfig: {
        ...(securityConfigExample as SecurityConfig),
        argon2id: {
          memoryCostKiB: 19456,
          timeCost: 2,
          parallelism: 1,
          saltBytes: 16,
          hashLength: 32,
        },
      },
      masterKeyMaterial: TEST_MASTER_KEY,
      store: fileBackend,
    });

    const setup = await auth.setupInitialOwner({
      owner_id: 'owner_disk',
      username: 'disk_owner',
      email: 'disk@tejaura.local',
      password: TEST_OWNER_PASS,
      correlation_id: 'corr_disk_setup',
    });
    assert.equal(setup.ok, true);

    const diskContent = fs.readFileSync(
      path.join(tmpDir, 'identity.enc.json'),
      'utf8',
    );
    const parsed = JSON.parse(diskContent) as { alg: string };
    assert.equal(parsed.alg, 'aes-256-gcm');
    assert.equal(diskContent.includes('disk_owner'), false);
    assert.equal(diskContent.includes(TEST_OWNER_PASS), false);

    // Cookie builder utility produces safe header
    const cookieHeader = buildSessionSetCookieHeader(
      'sample_opaque_token_string_1234567890',
      securityConfigExample.session as SecurityConfig['session'],
    );
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /Secure/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
