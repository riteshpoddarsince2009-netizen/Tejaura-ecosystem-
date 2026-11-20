import { validateControlledEndpointUrl } from '../endpoint-guard.ts';

export interface SafeHttpCallOptions {
  method: 'GET' | 'POST';
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SafeHttpCallResult {
  ok: boolean;
  status: number;
  latency_ms: number;
  json: unknown;
  raw_text?: string;
  cancelled: boolean;
  timed_out: boolean;
  error_code?: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function performSafeRuntimeHttpCall(
  options: SafeHttpCallOptions,
): Promise<SafeHttpCallResult> {
  const start = Date.now();
  const urlCheck = validateControlledEndpointUrl(options.url);
  if (!urlCheck.valid) {
    return {
      ok: false,
      status: 0,
      latency_ms: Date.now() - start,
      json: null,
      cancelled: false,
      timed_out: false,
      error_code: urlCheck.code ?? 'INVALID_ENDPOINT_URL',
      error: urlCheck.error ?? 'Blocked untrusted or invalid runtime URL.',
    };
  }

  if (options.signal?.aborted) {
    return {
      ok: false,
      status: 0,
      latency_ms: Date.now() - start,
      json: null,
      cancelled: true,
      timed_out: false,
      error_code: 'REQUEST_CANCELLED',
      error: 'Request aborted before dispatch.',
    };
  }

  const timeoutMs =
    typeof options.timeoutMs === 'number' &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  let cancelledByCaller = false;

  const onCallerAbort = () => {
    cancelledByCaller = true;
    controller.abort(options.signal?.reason ?? new Error('Caller aborted'));
  };

  if (options.signal) {
    options.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options.headers ?? {}),
    };
    const init: RequestInit = {
      method: options.method,
      headers,
      redirect: 'error',
      signal: controller.signal,
    };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(options.url, init);
    const rawText = await response.text();
    let parsedJson: unknown = null;

    if (rawText.trim().length > 0) {
      try {
        parsedJson = JSON.parse(rawText);
      } catch {
        parsedJson = null;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      latency_ms: Date.now() - start,
      json: parsedJson,
      raw_text: rawText,
      cancelled: false,
      timed_out: false,
      error_code: response.ok ? undefined : `HTTP_${response.status}`,
      error: response.ok
        ? undefined
        : `Runtime HTTP ${response.status}${rawText ? `: ${rawText.slice(0, 200)}` : ''}`,
    };
  } catch (err) {
    const latency = Date.now() - start;
    if (timedOut) {
      return {
        ok: false,
        status: 0,
        latency_ms: latency,
        json: null,
        cancelled: false,
        timed_out: true,
        error_code: 'REQUEST_TIMEOUT',
        error: `Runtime request timed out after ${timeoutMs}ms.`,
      };
    }
    if (cancelledByCaller || options.signal?.aborted) {
      return {
        ok: false,
        status: 0,
        latency_ms: latency,
        json: null,
        cancelled: true,
        timed_out: false,
        error_code: 'REQUEST_CANCELLED',
        error: 'Runtime request cancelled by caller.',
      };
    }
    return {
      ok: false,
      status: 0,
      latency_ms: latency,
      json: null,
      cancelled: false,
      timed_out: false,
      error_code: 'RUNTIME_CONNECTION_ERROR',
      error:
        err instanceof Error
          ? err.message
          : 'Failed to communicate with local runtime endpoint.',
    };
  } finally {
    clearTimeout(timer);
    if (options.signal) {
      options.signal.removeEventListener('abort', onCallerAbort);
    }
  }
}

export function normalizeBaseUrl(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}
