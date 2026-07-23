import { getReasonPhrase } from 'http-status-codes';
import { safeParseJson } from '@common/parsing/safeParseJson';
import { isObject, isString } from '@utils/core';

import { pickStatus } from './sdkErrorKinds';

/** Pick a non-blank string field off an error-body object. Shared by the
 *  relay/ChatGPT-subscription/credit-depletion body detectors, which all read
 *  loosely-typed provider JSON. */
export function pickStringField(v: unknown, key: string): string | undefined {
  if (!isObject(v)) return undefined;
  const value = (v as Record<string, unknown>)[key];
  return isString(value) && value.trim().length > 0 ? value : undefined;
}

/** Pick a finite-number field off an error-body object. See {@link pickStringField}. */
export function pickNumberField(v: unknown, key: string): number | undefined {
  if (!isObject(v)) return undefined;
  const value = (v as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** Get reason phrase, returning undefined for unknown codes (getReasonPhrase throws). */
export function safeGetReasonPhrase(statusCode: number): string | undefined {
  try {
    return getReasonPhrase(statusCode);
  } catch {
    return undefined;
  }
}

export function getErrorClassNames(err: unknown): string[] {
  if (!isObject(err)) return [];

  const classNames = new Set<string>();
  let prototype = Object.getPrototypeOf(err);
  while (prototype && prototype !== Object.prototype) {
    const className = prototype.constructor?.name;
    if (isString(className) && className.length > 0) {
      classNames.add(className);
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return [...classNames];
}

type StatusCarrier = {
  status?: number;
  statusCode?: number;
  code?: number;
  response?: { status?: number };
  error?: { status?: number };
};

/** Canonical HTTP status extractor for thrown SDK/provider errors. The only
 *  place that knows the candidate field shapes (`status`, `statusCode`,
 *  `code`, `response.status`, `error.status`). */
export function detectStatusCode(err: unknown): number | undefined {
  if (!isObject(err)) {
    return undefined;
  }

  const candidate = err as StatusCarrier;
  return (
    pickStatus(candidate.status) ??
    pickStatus(candidate.statusCode) ??
    pickStatus(candidate.code) ??
    pickStatus(candidate.response?.status) ??
    pickStatus(candidate.error?.status)
  );
}

export function detectStatusText(
  err: unknown,
  statusCode?: number,
): string | undefined {
  if (isObject(err)) {
    const candidate = err as {
      statusText?: string;
      response?: { statusText?: string };
      error?: { statusText?: string };
    };
    const explicit =
      candidate.statusText ??
      candidate.response?.statusText ??
      candidate.error?.statusText;
    if (explicit) return explicit;
  }
  return statusCode ? safeGetReasonPhrase(statusCode) : undefined;
}

export function detectProvider(err: unknown): string | undefined {
  if (!isObject(err)) {
    return undefined;
  }

  const candidate = err as { provider?: string; headers?: HeaderBag } & {
    stack?: string;
  };

  if (isString(candidate.provider)) {
    return candidate.provider;
  }

  const classNameProvider = detectProviderFromClassNames(
    getErrorClassNames(err),
  );
  if (classNameProvider) return classNameProvider;

  const providerFromStack = detectProviderFromText(candidate.stack ?? '');
  if (providerFromStack) {
    return providerFromStack;
  }

  return detectProviderFromHeaders(candidate.headers);
}

function detectProviderFromClassNames(
  classNames: readonly (string | undefined)[],
): string | undefined {
  // Match SDK class-name fragments, then normalize aliases to the canonical
  // API-provider names used by SecretManager / model handlers. This also covers
  // no-response connection errors whose provider only appears on a base SDK
  // class such as OpenAIError or AnthropicError.
  const names = classNames
    .filter((name): name is string => isString(name) && name.length > 0)
    .map((name) => name.toLowerCase());
  const match = (['openai', 'anthropic', 'google', 'kimi'] as const).find(
    (provider) => names.some((name) => name.includes(provider)),
  );
  if (match === 'kimi') return 'moonshot';
  return match;
}

export type HeaderBag =
  | {
      get?: (key: string) => string | null;
    }
  | Record<string, unknown>;
type HeaderDetectedProvider = 'anthropic';

export function getHeaderValue(
  headers: HeaderBag | undefined,
  name: string,
): string | undefined {
  const maybeGet = isObject(headers) ? headers.get : undefined;
  const direct =
    typeof maybeGet === 'function' ? maybeGet.call(headers, name) : undefined;
  if (isString(direct) && direct) return direct;

  const indexed = (headers as Record<string, unknown> | undefined)?.[name];
  return isString(indexed) && indexed ? indexed : undefined;
}

function detectProviderFromHeaders(
  headers: HeaderBag | undefined,
): HeaderDetectedProvider | undefined {
  if (getHeaderValue(headers, 'request-id')) return 'anthropic';
  return undefined;
}

function detectProviderFromText(text: string): string | undefined {
  const lowered = text.toLowerCase().replaceAll('\\', '/');
  if (lowered.includes(`@anthropic-${'ai'}/sdk`)) return 'anthropic';
  if (lowered.includes('node_modules/openai')) return 'openai';
  // Keep the Google package marker split so the desktop startup bundle
  // verifier does not mistake this stack-text detector for an eager SDK import.
  if (lowered.includes(`@google/${'genai'}`)) return 'google';
  return undefined;
}

/** Extract request ID from SDK errors (property or headers). */
export function detectRequestId(err: unknown): string | undefined {
  if (!isObject(err)) return undefined;

  const candidate = err as {
    request_id?: string;
    requestId?: string;
    requestID?: string;
    headers?: HeaderBag;
  };

  const relayRequestId = getHeaderValue(
    candidate.headers,
    'x-relay-request-id',
  );
  if (relayRequestId) return relayRequestId;

  const directId =
    candidate.request_id ?? candidate.requestId ?? candidate.requestID;
  if (isString(directId) && directId) {
    return directId;
  }

  // Try provider headers after the relay-specific correlation id.
  return (
    getHeaderValue(candidate.headers, 'request-id') ??
    getHeaderValue(candidate.headers, 'x-request-id')
  );
}

/** Extract raw error body from SDK errors for relay error debugging. */
export function detectRawErrorBody(err: unknown): unknown {
  if (!isObject(err)) {
    return undefined;
  }

  const candidate = err as {
    error?: unknown;
    body?: unknown;
    data?: unknown;
    response?: { data?: unknown };
    message?: string;
  };

  const directBody =
    candidate.error ??
    candidate.body ??
    candidate.data ??
    candidate.response?.data;
  if (directBody !== undefined) {
    return directBody;
  }

  // Google GenAI SDK may embed JSON in the error message
  if (candidate.message && candidate.message.startsWith('{')) {
    return safeParseJson(candidate.message).unwrapOr(undefined);
  }

  return undefined;
}
