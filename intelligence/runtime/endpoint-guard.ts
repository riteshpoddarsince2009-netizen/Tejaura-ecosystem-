import type {
  LocalRuntimeType,
  TrustedRuntimeEndpoint,
} from './runtime-types.ts';

const FORBIDDEN_THIRD_PARTY_API_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com',
  'api.groq.com',
  'api.together.xyz',
  'api.cohere.ai',
  'api.cohere.com',
  'api.mistral.ai',
  'api.perplexity.ai',
  'api.deepseek.com',
  'api.fireworks.ai',
  'api.replicate.com',
];

const FORBIDDEN_HOST_SUFFIXES = [
  '.openai.azure.com',
  '.amazonaws.com',
];

export interface EndpointCheckResult {
  valid: boolean;
  normalized_url?: string;
  code?: string;
  error?: string;
}

export function isForbiddenThirdPartyHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (FORBIDDEN_THIRD_PARTY_API_HOSTS.includes(lower)) {
    return true;
  }
  return FORBIDDEN_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '::1') {
    return true;
  }
  if (lower.startsWith('10.') || lower.startsWith('192.168.')) {
    return true;
  }
  const match172 = /^172\.(\d+)\./.exec(lower);
  if (match172) {
    const secondOctet = Number(match172[1]);
    return secondOctet >= 16 && secondOctet <= 31;
  }
  return false;
}

export function validateControlledEndpointUrl(
  rawUrl: string,
): EndpointCheckResult {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return {
      valid: false,
      code: 'INVALID_ENDPOINT_URL',
      error: 'Runtime endpoint URL must be a non-empty string.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      valid: false,
      code: 'MALFORMED_ENDPOINT_URL',
      error: `Runtime endpoint "${rawUrl}" is not a valid URL.`,
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false,
      code: 'UNSUPPORTED_ENDPOINT_PROTOCOL',
      error: `Runtime endpoint protocol "${parsed.protocol}" is not permitted.`,
    };
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return {
      valid: false,
      code: 'ENDPOINT_CREDENTIALS_FORBIDDEN',
      error: 'Runtime endpoint URL must not embed credentials.',
    };
  }

  if (isForbiddenThirdPartyHost(parsed.hostname)) {
    return {
      valid: false,
      code: 'PAID_THIRD_PARTY_API_FORBIDDEN',
      error: `Third-party commercial AI API host "${parsed.hostname}" is prohibited by TEJAURA local-first policy.`,
    };
  }

  if (parsed.protocol === 'http:' && !isPrivateOrLoopbackHost(parsed.hostname)) {
    return {
      valid: false,
      code: 'INSECURE_REMOTE_HTTP_FORBIDDEN',
      error: `Non-local endpoint "${parsed.hostname}" must use HTTPS.`,
    };
  }

  const normalized = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  return {
    valid: true,
    normalized_url: normalized,
  };
}

export function resolveTrustedEndpoint(
  requestedEndpoint: string,
  runtimeType: LocalRuntimeType,
  trustedEndpoints: readonly TrustedRuntimeEndpoint[],
): {
  trusted: boolean;
  endpoint?: TrustedRuntimeEndpoint;
  normalized_url?: string;
  code?: string;
  error?: string;
} {
  const urlCheck = validateControlledEndpointUrl(requestedEndpoint);
  if (!urlCheck.valid || !urlCheck.normalized_url) {
    return {
      trusted: false,
      code: urlCheck.code ?? 'INVALID_ENDPOINT_URL',
      error: urlCheck.error ?? 'Invalid runtime endpoint URL.',
    };
  }

  let requestedOrigin: string;
  try {
    requestedOrigin = new URL(urlCheck.normalized_url).origin;
  } catch {
    return {
      trusted: false,
      code: 'MALFORMED_ENDPOINT_URL',
      error: 'Failed to parse requested endpoint origin.',
    };
  }

  for (const candidate of trustedEndpoints) {
    if (!candidate.enabled || candidate.runtime_type !== runtimeType) {
      continue;
    }

    const candidateCheck = validateControlledEndpointUrl(candidate.base_url);
    if (!candidateCheck.valid || !candidateCheck.normalized_url) {
      continue;
    }

    const candidateOrigin = new URL(candidateCheck.normalized_url).origin;
    if (
      candidateOrigin === requestedOrigin &&
      (urlCheck.normalized_url === candidateCheck.normalized_url ||
        urlCheck.normalized_url.startsWith(`${candidateCheck.normalized_url}/`))
    ) {
      return {
        trusted: true,
        endpoint: candidate,
        normalized_url: candidateCheck.normalized_url,
      };
    }
  }

  return {
    trusted: false,
    code: 'UNTRUSTED_RUNTIME_ENDPOINT',
    error: `Endpoint "${requestedEndpoint}" is not registered in the trusted owner-configured runtime allowlist.`,
  };
}
