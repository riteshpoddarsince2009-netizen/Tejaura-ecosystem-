import {
  decryptAes256Gcm,
  encryptAes256Gcm,
  generateOpaqueToken,
  sha256Hex,
} from '../security/index.ts';
import type {
  SecurityConfig,
  StoredSessionRecord,
  TejauraRole,
} from '../security/index.ts';

export interface SessionMetadataPayload {
  client_ip?: string;
  user_agent?: string;
}

export interface IssuedSession {
  rawToken: string;
  record: StoredSessionRecord;
  setCookieHeader: string;
}

export function buildSessionSetCookieHeader(
  rawToken: string,
  sessionPolicy: SecurityConfig['session'],
): string {
  const sameSite = sessionPolicy.sameSite === 'strict' ? 'Strict' : 'Lax';
  // Enforce HttpOnly, Secure, SameSite, Path=/, Max-Age
  return [
    `${sessionPolicy.cookieName}=${encodeURIComponent(rawToken)}`,
    `Path=${sessionPolicy.path}`,
    `Max-Age=${sessionPolicy.ttlSeconds}`,
    `SameSite=${sameSite}`,
    'HttpOnly',
    'Secure',
  ].join('; ');
}

export function buildClearSessionCookieHeader(
  sessionPolicy: SecurityConfig['session'],
): string {
  const sameSite = sessionPolicy.sameSite === 'strict' ? 'Strict' : 'Lax';
  return [
    `${sessionPolicy.cookieName}=`,
    `Path=${sessionPolicy.path}`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    `SameSite=${sameSite}`,
    'HttpOnly',
    'Secure',
  ].join('; ');
}

export function parseSessionTokenFromCookieHeader(
  cookieHeader: string | undefined,
  cookieName: string,
): string | null {
  if (typeof cookieHeader !== 'string' || cookieHeader.trim().length === 0) {
    return null;
  }

  const pairs = cookieHeader.split(';');
  for (const part of pairs) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) continue;
    const name = part.slice(0, eqIndex).trim();
    if (name !== cookieName) continue;
    const rawVal = part.slice(eqIndex + 1).trim();
    if (!rawVal) return null;
    try {
      return decodeURIComponent(rawVal);
    } catch {
      return null;
    }
  }
  return null;
}

export class SessionManager {
  private readonly policy: SecurityConfig['session'];
  private readonly encryptionKey: Buffer;
  private readonly clock: () => Date;

  constructor(options: {
    policy: SecurityConfig['session'];
    encryptionKey: Buffer;
    clock?: () => Date;
  }) {
    this.policy = options.policy;
    this.encryptionKey = options.encryptionKey;
    this.clock = options.clock ?? (() => new Date());
  }

  createSession(params: {
    actorId: string;
    role: TejauraRole;
    existingSessions: StoredSessionRecord[];
    metadata?: SessionMetadataPayload;
  }): { issued: IssuedSession; updatedSessions: StoredSessionRecord[] } {
    const now = this.clock();
    const nowMs = now.getTime();
    const rawToken = generateOpaqueToken(32);
    const tokenHash = sha256Hex(rawToken);
    const sessionId = `sess_${generateOpaqueToken(16)}`;

    const expiresAt = new Date(nowMs + this.policy.ttlSeconds * 1000).toISOString();
    const idleExpiresAt = new Date(
      nowMs + this.policy.idleTimeoutSeconds * 1000,
    ).toISOString();

    const encryptedMetadata = params.metadata
      ? encryptAes256Gcm(
          JSON.stringify(params.metadata),
          this.encryptionKey,
          `session:${sessionId}`,
          'session-v1',
        )
      : null;

    const newRecord: StoredSessionRecord = {
      session_id: sessionId,
      token_hash: tokenHash,
      actor_id: params.actorId,
      role: params.role,
      created_at: now.toISOString(),
      last_seen_at: now.toISOString(),
      idle_expires_at: idleExpiresAt,
      expires_at: expiresAt,
      revoked_at: null,
      revocation_reason: null,
      encrypted_metadata: encryptedMetadata,
    };

    // Prune expired sessions and enforce maxActiveSessionsPerOwner (evicting oldest active).
    const active = params.existingSessions.filter(
      (s) =>
        s.revoked_at === null &&
        new Date(s.expires_at).getTime() > nowMs &&
        new Date(s.idle_expires_at).getTime() > nowMs,
    );

    const trimmedActive =
      active.length >= this.policy.maxActiveSessionsPerOwner
        ? active
            .sort(
              (a, b) =>
                new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime(),
            )
            .slice(0, this.policy.maxActiveSessionsPerOwner - 1)
        : active;

    // Keep recently revoked records for audit correlation (capped) + active + new session.
    const revoked = params.existingSessions
      .filter((s) => s.revoked_at !== null)
      .slice(-20);

    const updatedSessions = [...revoked, ...trimmedActive, newRecord];

    return {
      issued: {
        rawToken,
        record: newRecord,
        setCookieHeader: buildSessionSetCookieHeader(rawToken, this.policy),
      },
      updatedSessions,
    };
  }

  verifyAndTouchSession(params: {
    rawToken: string;
    sessions: StoredSessionRecord[];
  }):
    | {
        valid: true;
        record: StoredSessionRecord;
        updatedSessions: StoredSessionRecord[];
      }
    | { valid: false; code: string; error: string } {
    if (typeof params.rawToken !== 'string' || params.rawToken.trim().length < 32) {
      return {
        valid: false,
        code: 'INVALID_SESSION_TOKEN',
        error: 'Session token is missing or malformed.',
      };
    }

    const tokenHash = sha256Hex(params.rawToken);
    const matchIndex = params.sessions.findIndex(
      (s) => s.token_hash === tokenHash,
    );

    if (matchIndex === -1) {
      return {
        valid: false,
        code: 'SESSION_NOT_FOUND',
        error: 'Session does not exist or has been evicted.',
      };
    }

    const record = params.sessions[matchIndex]!;
    if (record.revoked_at !== null) {
      return {
        valid: false,
        code: 'SESSION_REVOKED',
        error: 'Session has been revoked.',
      };
    }

    const now = this.clock();
    const nowMs = now.getTime();
    if (new Date(record.expires_at).getTime() <= nowMs) {
      return {
        valid: false,
        code: 'SESSION_EXPIRED',
        error: 'Session has exceeded its maximum lifetime.',
      };
    }

    if (new Date(record.idle_expires_at).getTime() <= nowMs) {
      return {
        valid: false,
        code: 'SESSION_IDLE_EXPIRED',
        error: 'Session expired due to inactivity.',
      };
    }

    const nextIdleMs = Math.min(
      nowMs + this.policy.idleTimeoutSeconds * 1000,
      new Date(record.expires_at).getTime(),
    );

    const touched: StoredSessionRecord = {
      ...record,
      last_seen_at: now.toISOString(),
      idle_expires_at: new Date(nextIdleMs).toISOString(),
    };

    const updatedSessions = params.sessions.map((s, idx) =>
      idx === matchIndex ? touched : s,
    );

    return {
      valid: true,
      record: touched,
      updatedSessions,
    };
  }

  decryptSessionMetadata(
    record: StoredSessionRecord,
  ): SessionMetadataPayload | null {
    if (!record.encrypted_metadata) return null;
    try {
      const json = decryptAes256Gcm(
        record.encrypted_metadata,
        this.encryptionKey,
        `session:${record.session_id}`,
      );
      return JSON.parse(json) as SessionMetadataPayload;
    } catch {
      return null;
    }
  }

  revokeByToken(
    rawToken: string,
    sessions: StoredSessionRecord[],
    reason: string,
  ): {
    revokedSessionId: string | null;
    actorId: string | null;
    updatedSessions: StoredSessionRecord[];
  } {
    const tokenHash = sha256Hex(rawToken);
    const nowIso = this.clock().toISOString();
    let revokedSessionId: string | null = null;
    let actorId: string | null = null;

    const updatedSessions = sessions.map((s) => {
      if (s.token_hash === tokenHash && s.revoked_at === null) {
        revokedSessionId = s.session_id;
        actorId = s.actor_id;
        return {
          ...s,
          revoked_at: nowIso,
          revocation_reason: reason,
        };
      }
      return s;
    });

    return { revokedSessionId, actorId, updatedSessions };
  }

  revokeBySessionId(
    sessionId: string,
    sessions: StoredSessionRecord[],
    reason: string,
  ): {
    revoked: boolean;
    actorId: string | null;
    updatedSessions: StoredSessionRecord[];
  } {
    const nowIso = this.clock().toISOString();
    let revoked = false;
    let actorId: string | null = null;

    const updatedSessions = sessions.map((s) => {
      if (s.session_id === sessionId && s.revoked_at === null) {
        revoked = true;
        actorId = s.actor_id;
        return {
          ...s,
          revoked_at: nowIso,
          revocation_reason: reason,
        };
      }
      return s;
    });

    return { revoked, actorId, updatedSessions };
  }

  revokeAllForActor(
    actorId: string,
    sessions: StoredSessionRecord[],
    reason: string,
  ): {
    revokedCount: number;
    updatedSessions: StoredSessionRecord[];
  } {
    const nowIso = this.clock().toISOString();
    let revokedCount = 0;

    const updatedSessions = sessions.map((s) => {
      if (s.actor_id === actorId && s.revoked_at === null) {
        revokedCount += 1;
        return {
          ...s,
          revoked_at: nowIso,
          revocation_reason: reason,
        };
      }
      return s;
    });

    return { revokedCount, updatedSessions };
  }
}
