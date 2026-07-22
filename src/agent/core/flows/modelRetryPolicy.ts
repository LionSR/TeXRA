import type { ModelCredentialRoute } from '@agent/types/ModelHandlerContracts';
import { detectStatusCode } from '@common/errors/sdkErrorUtils';
import { isObject } from '@utils/core';

const TRANSPORT_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

function errorCauseChain(error: Error): unknown[] {
  const chain: unknown[] = [];
  for (
    let current: unknown = error;
    isObject(current);
    current = (current as { cause?: unknown }).cause
  ) {
    chain.push(current);
  }
  return chain;
}

function isTransportFailure(error: Error): boolean {
  return errorCauseChain(error).some((current) => {
    const candidate = current as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
    };
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    const name = typeof candidate.name === 'string' ? candidate.name : '';
    const message =
      typeof candidate.message === 'string' ? candidate.message : '';
    return (
      code.startsWith('UND_ERR_') ||
      TRANSPORT_ERROR_CODES.has(code) ||
      /(?:Connection|Timeout)Error$/.test(name) ||
      /^(?:fetch failed|failed to fetch)$/i.test(message.trim())
    );
  });
}

function retryAfterMs(error: Error): number | undefined {
  for (const current of errorCauseChain(error)) {
    const headers = (current as { headers?: unknown }).headers;
    if (!isObject(headers)) continue;
    const get = Reflect.get(headers, 'get');
    const read = (name: string): unknown =>
      typeof get === 'function'
        ? Reflect.apply(get, headers, [name])
        : Reflect.get(headers, name);
    const rawExplicitMs = read('retry-after-ms');
    if (rawExplicitMs != null) {
      const explicitMs = Number(rawExplicitMs);
      if (Number.isFinite(explicitMs) && explicitMs >= 0) return explicitMs;
    }

    const retryAfter = read('retry-after');
    if (typeof retryAfter !== 'string') continue;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}

/** Identity of a wire route shared by concurrent model calls. */
export function modelRetryRoute(input: {
  provider: string;
  credentialRoute?: ModelCredentialRoute;
  endpoint: string;
}): string {
  return JSON.stringify([
    input.provider,
    input.credentialRoute ?? 'configured',
    input.endpoint,
  ]);
}

/** Classify only failures that carry evidence about a shared wire route. */
export function classifyModelRouteFailure(
  error: Error,
): { retryAfterMs?: number } | undefined {
  const statusCode = detectStatusCode(error);
  if (
    statusCode !== 408 &&
    statusCode !== 409 &&
    statusCode !== 429 &&
    (statusCode == null || statusCode < 500) &&
    !isTransportFailure(error)
  ) {
    return undefined;
  }
  return { retryAfterMs: retryAfterMs(error) };
}
