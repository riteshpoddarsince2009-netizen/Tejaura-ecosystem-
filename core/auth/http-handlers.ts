import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { enforceHttpsTransport } from '../security/index.ts';
import type { TejauraAuthService } from './auth-service.ts';
import type { AuthRequestContext, AuthenticatedSessionContext } from './auth-types.ts';

export interface TejauraAuthenticatedRequest extends Request {
  tejauraSession?: AuthenticatedSessionContext;
}

export function extractAuthRequestContext(req: Request): AuthRequestContext {
  const socketEncrypted =
    Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted) ||
    req.secure === true;
  const forwardedProto = req.header('x-forwarded-proto');
  const forwardedHost = req.header('x-forwarded-host');
  const host = req.header('host');
  const userAgent = req.header('user-agent');
  const origin = req.header('origin');
  const secFetchSite = req.header('sec-fetch-site');
  const secFetchDest = req.header('sec-fetch-dest');

  return {
    protocol: req.protocol,
    encrypted: socketEncrypted,
    host,
    forwardedProto,
    forwardedHost,
    clientIp: req.ip ?? req.socket?.remoteAddress,
    userAgent,
    origin,
    secFetchSite,
    secFetchDest,
    environment:
      process.env.NODE_ENV === 'production' ? 'production' : 'local',
  };
}

export function applySecurityResponseHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function validateSameOriginForMutation(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }

  const origin = req.header('origin');
  const forwardedHost = (req.header('x-forwarded-host') ?? '')
    .split(',')[0]
    ?.trim()
    .toLowerCase();
  const host = (req.header('host') ?? '').trim().toLowerCase();
  if (!origin) {
    // Non-browser API clients without Origin still require HttpOnly cookie + CSRF-safe headers.
    return true;
  }
  if (!host && !forwardedHost) {
    return false;
  }

  try {
    const parsedOriginHost = new URL(origin).host.toLowerCase();
    return (
      (host.length > 0 && parsedOriginHost === host) ||
      (forwardedHost.length > 0 && parsedOriginHost === forwardedHost)
    );
  } catch {
    return false;
  }
}

/**
 * Express middleware enforcing HTTPS in deployment, security response headers,
 * Same-Origin check on state-changing requests, and verified owner session cookies.
 */
export function createRequireOwnerAuthMiddleware(authService: TejauraAuthService) {
  return (
    req: TejauraAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): void => {
    applySecurityResponseHeaders(res);

    const requestCtx = extractAuthRequestContext(req);
    const transport = enforceHttpsTransport(
      requestCtx,
      authService.getSecurityConfig().transport,
    );
    if (!transport.allowed) {
      res.status(426).json({
        ok: false,
        code: transport.code,
        error: transport.error,
      });
      return;
    }

    if (!validateSameOriginForMutation(req)) {
      res.status(403).json({
        ok: false,
        code: 'CSRF_ORIGIN_MISMATCH',
        error: 'Request Origin header does not match host.',
      });
      return;
    }

    const authResult = authService.authenticateSessionFromCookieHeader(
      req.header('cookie'),
      requestCtx,
    );
    if (!authResult.ok) {
      res.status(401).json({
        ok: false,
        code: authResult.code,
        error: authResult.error,
      });
      return;
    }

    req.tejauraSession = authResult.session;
    next();
  };
}

export function resolveCorrelationId(req: Request): string {
  const headerVal = req.header('x-correlation-id');
  if (typeof headerVal === 'string' && /^[a-zA-Z0-9._:-]{2,64}$/.test(headerVal)) {
    return headerVal;
  }
  return `corr_${crypto.randomUUID()}`;
}
