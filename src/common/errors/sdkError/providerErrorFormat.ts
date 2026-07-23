import stableStringify from 'fast-json-stable-stringify';
import { StatusCodes } from 'http-status-codes';

import { safeParseJson } from '@common/parsing/safeParseJson';
import {
  type ErrorContext,
  type ErrorLogData,
  type ExhaustionReason,
  type ProviderError,
  type RetryErrorInfo,
  normalizeLegacyProviderErrorFields,
  toRetryErrorInfo,
} from '@shared/schemas';
import {
  extractErrorMessage,
  toErrorMessage,
} from '@utils/errors/errorMessage';
import { findInCauseChain, isDiskFullError } from '../errorPredicates';
import { isContextWindowError, isUserAbort } from './errorPatterns';
import {
  detectPartialText,
  detectSdkErrorMetadata,
  detectStreamDiagnostics,
  providerErrorMetadata,
} from './errorMetadata';
import {
  type HeaderBag,
  detectProvider,
  detectRawErrorBody,
  detectRequestId,
  detectStatusCode,
  detectStatusText,
  getErrorClassNames,
  getHeaderValue,
  pickStringField,
  safeGetReasonPhrase,
} from './errorInspection';
import {
  inferStatusCodeFromBody,
  isRelayError,
  isRelayMonthlyLimitBody,
  isRelayMonthlyLimitMessage,
  isRelayRequestLimitBody,
  isUpstreamCreditDepletedBody,
} from './relayDetection';
import {
  describeChatGptSubscriptionLimit,
  parseChatGptSubscriptionLimit,
} from './chatgptSubscriptionDetection';
import {
  type SdkErrorEntry,
  SDK_ERRORS,
  SDK_ERRORS_BY_KIND,
  isRetryableStatusCode,
} from './sdkErrorKinds';

/** Partial result before relay detection (isRelayError/rawErrorBody added later). */
type SdkMatchResult = Omit<ProviderError, 'isRelayError' | 'rawErrorBody'>;

/**
 * Single source of truth for the user-facing HTTP error string and its message
 * fallbacks: the status text, the `HTTP {code}[ {text}] – {message}` prefix,
 * the reason-phrase fallback, and the `'Provider request failed'` last resort.
 * Pure display formatting — it does not touch retry/recovery classification.
 */
function describeHttpError(
  err: unknown,
  statusCode: number | undefined,
  extractedMessage: string | undefined,
  rawErrorBody: unknown,
): { statusText: string | undefined; message: string } {
  const statusText = detectStatusText(err, statusCode);
  const fallbackMessage = statusCode
    ? safeGetReasonPhrase(statusCode)
    : undefined;
  const bodyMessage =
    pickStringField(rawErrorBody, 'message') ??
    pickStringField(
      typeof rawErrorBody === 'object' && rawErrorBody !== null
        ? (rawErrorBody as { error?: unknown }).error
        : undefined,
      'message',
    );
  // Some SDKs stringify the complete response body into Error.message when
  // the body has no scalar message. Keep that body on rawErrorBody for
  // diagnostics, but do not promote its serialization to user-facing text.
  let wrapperMessageContainsRawBody = false;
  if (extractedMessage !== undefined && rawErrorBody !== undefined) {
    if (typeof rawErrorBody === 'string') {
      wrapperMessageContainsRawBody =
        extractedMessage === rawErrorBody ||
        extractedMessage.includes(JSON.stringify(rawErrorBody));
    }

    if (typeof rawErrorBody === 'object' && rawErrorBody !== null) {
      try {
        const serializedRawBody = JSON.stringify(rawErrorBody);
        wrapperMessageContainsRawBody =
          serializedRawBody.length > 2 &&
          extractedMessage.includes(serializedRawBody);
      } catch {
        // Non-serializable diagnostic bodies cannot have been JSON-stringified
        // into the SDK wrapper message by the path guarded here.
      }

      if (!wrapperMessageContainsRawBody) {
        const opening = Array.isArray(rawErrorBody) ? '[' : '{';
        const closing = Array.isArray(rawErrorBody) ? ']' : '}';
        const start = extractedMessage.indexOf(opening);
        const end = extractedMessage.lastIndexOf(closing);
        if (start >= 0 && end > start) {
          const embeddedBody = safeParseJson(
            extractedMessage.slice(start, end + 1),
          ).unwrapOr(undefined);
          try {
            wrapperMessageContainsRawBody =
              stableStringify(embeddedBody) === stableStringify(rawErrorBody);
          } catch {
            // Circular or otherwise non-JSON diagnostics cannot match a JSON
            // fragment parsed from the wrapper message.
          }
        }
      }
    }
  }
  const finalMessage =
    (wrapperMessageContainsRawBody ? undefined : extractedMessage) ??
    bodyMessage ??
    fallbackMessage ??
    'Provider request failed';
  const message = statusCode
    ? `HTTP ${statusCode}${statusText ? ` ${statusText}` : ''} – ${finalMessage}`
    : finalMessage;
  return { statusText, message };
}

function matchLegacySdkError(err: unknown): SdkErrorEntry | undefined {
  const errorClassNames = getErrorClassNames(err);
  return SDK_ERRORS.find(({ classNames }) =>
    classNames.some((className) => errorClassNames.includes(className)),
  );
}

/** Match known SDK error types and return structured error details. */
function matchSdkError(
  err: unknown,
  rawErrorBody: unknown,
): SdkMatchResult | undefined {
  const metadata = detectSdkErrorMetadata(err);
  const entry =
    (metadata ? SDK_ERRORS_BY_KIND.get(metadata.kind) : undefined) ??
    matchLegacySdkError(err);
  if (!entry) {
    return undefined;
  }

  const provider = metadata?.provider ?? detectProvider(err);
  const requestId = detectRequestId(err);

  // Message-only errors (connection, abort) - use the entry's message
  if (entry.message !== undefined) {
    return {
      message: entry.message,
      provider,
      userRetryable: entry.userRetryable ?? false,
      requestId,
    };
  }

  // HTTP errors - detect status code from error object, SDK class, or error body.
  // If detectStatusCode returns a non-error code (< 400), it's likely misleading
  // (e.g., SSE connection status 200 while the actual error is in the body),
  // so prefer the body-inferred status code in that case.
  const rawStatusCode = metadata?.statusCode ?? detectStatusCode(err);
  const statusCode =
    (rawStatusCode !== undefined && rawStatusCode >= 400
      ? rawStatusCode
      : undefined) ??
    entry.fallbackStatusCode ??
    inferStatusCodeFromBody(rawErrorBody) ??
    rawStatusCode;
  const { statusText, message } = describeHttpError(
    err,
    statusCode,
    extractErrorMessage(err),
    rawErrorBody,
  );

  if (!statusCode) {
    // SDK errors without status codes are unusual - be conservative and don't offer retry
    return {
      message,
      provider,
      userRetryable: false,
      requestId,
    };
  }

  return {
    message,
    statusCode,
    statusText,
    provider,
    userRetryable: isRetryableStatusCode(statusCode),
    requestId,
  };
}

/**
 * Builds a fresh `ProviderError` without caching it on the thrown value.
 *
 * @internal Production code should call {@link normalizeProviderError}, the
 * single public entry that classifies once and caches the result on the
 * error. This stays module-exported for tests that assert raw formatting.
 */
export function formatProviderHttpError(err: unknown): ProviderError {
  const rawErrorBody = detectRawErrorBody(err);
  const streamDiagnostics = detectStreamDiagnostics(err);
  const partialText = detectPartialText(err);
  const extractedMessage = extractErrorMessage(err);
  const sdkExhaustionReason = detectSdkErrorMetadata(err)?.exhaustionReason;
  const isRelayMonthlyLimitByMessage =
    isRelayMonthlyLimitMessage(extractedMessage);
  const isRelay = isRelayError(rawErrorBody) || isRelayMonthlyLimitByMessage;
  // Credit exhaustion matches regardless of relay status: a direct
  // Anthropic 400 "credit balance is too low" still wants the "Use your
  // own API key" affordance so the user can switch credentials.
  const isUpstreamCreditDepleted = isUpstreamCreditDepletedBody(rawErrorBody);
  // ChatGPT-subscription (Codex) quota exhaustion. Treated as a credential
  // exhaustion so auto-retry is suppressed (the quota won't return mid-run) and
  // the retry UI offers a switch to the user's own API key — but it disables
  // the subscription preference, not relay, on accept.
  const chatgptSubscriptionLimit = parseChatGptSubscriptionLimit(rawErrorBody);
  const isChatGptSubscriptionLimited = chatgptSubscriptionLimit !== null;
  const chatgptSubscriptionMessage = chatgptSubscriptionLimit
    ? describeChatGptSubscriptionLimit(chatgptSubscriptionLimit)
    : undefined;
  // Priority mirrors the pre-refactor OR order: ChatGPT-subscription and
  // upstream-credit are independently detected first; relay monthly limit
  // (by body or message) is the remaining exhaustion condition. Explicit SDK
  // metadata precedes these legacy body heuristics.
  let exhaustionReason: ExhaustionReason | undefined = sdkExhaustionReason;
  if (exhaustionReason === undefined) {
    if (isChatGptSubscriptionLimited) {
      exhaustionReason = 'chatgpt-subscription';
    } else if (isUpstreamCreditDepleted) {
      exhaustionReason = 'upstream-credit';
    } else if (
      isRelayMonthlyLimitBody(rawErrorBody) ||
      isRelayMonthlyLimitByMessage
    ) {
      exhaustionReason = 'relay-limit';
    }
  }
  const isCredentialExhausted = exhaustionReason !== undefined;

  // Terminal failures (user abort, local disk-full): never retryable and never
  // a relay/credential affordance. Carries diagnostics but deliberately opts
  // out of the credential classification computed below.
  function terminalError(message: string): ProviderError {
    return {
      message,
      userRetryable: false,
      isRelayError: false,
      rawErrorBody,
      streamDiagnostics,
      partialText,
    };
  }

  // Handle DOMException AbortError (from AbortController.abort())
  if (err instanceof DOMException && err.name === 'AbortError') {
    return terminalError('Request aborted');
  }

  // Disk full — local I/O error, no retry will help
  if (isDiskFullError(err)) {
    return terminalError(
      'No space left on device. Free up disk space and try again.',
    );
  }

  // Context-window overflow — deterministic: a retry resends the same
  // oversized payload and fails again. Handler-level recovery (compaction,
  // dropping previous_response_id) runs before the error reaches this
  // classifier, so an overflow that arrives here is terminal for this turn.
  // Guarded on the status code because isContextWindowError also matches by
  // message wording, and a retryable provider error (e.g. a 429 mentioning
  // tokens) must keep its retry affordance.
  const detectedOverflowStatusCode = detectStatusCode(err);
  const overflowStatusCode =
    (detectedOverflowStatusCode !== undefined &&
    detectedOverflowStatusCode >= 400
      ? detectedOverflowStatusCode
      : undefined) ??
    inferStatusCodeFromBody(rawErrorBody) ??
    detectedOverflowStatusCode;
  if (
    isContextWindowError(err) &&
    (overflowStatusCode === undefined ||
      !isRetryableStatusCode(overflowStatusCode))
  ) {
    return terminalError(
      `${extractedMessage ?? 'Conversation exceeds the model context window.'} ` +
        'Retrying would resend the same oversized request. Start a new ' +
        'session, or reduce attached files and tool output.',
    );
  }

  // Classification flags + diagnostics carried by BOTH the SDK-matched and the
  // unrecognized returns below. The abort / disk-full early returns above
  // deliberately opt out (always non-relay, no credential flags). Single source
  // for these fields so adding a future flag touches one place, not two.
  const classification = {
    isRelayError: isRelay,
    exhaustionReason,
    rawErrorBody,
    streamDiagnostics,
    partialText,
  };

  // Try matching a known SDK error type (connection, abort, HTTP errors)
  const sdkMatch = matchSdkError(err, rawErrorBody);
  if (sdkMatch) {
    return {
      ...sdkMatch,
      ...classification,
      // Prefer the actionable subscription-limit message over the raw
      // `HTTP 429 – The usage limit has been reached`.
      message: chatgptSubscriptionMessage ?? sdkMatch.message,
      // Credential-exhausted errors keep userRetryable=true so the retry
      // panel surfaces with the "Use your own API key" affordance, but
      // shouldAutoRetry separately suppresses auto-retry for them — a
      // fresh attempt with the same depleted credential would just fail.
      userRetryable: isRelay || sdkMatch.userRetryable || isCredentialExhausted,
    };
  }

  // Unrecognized error — extract what we can
  const statusCode =
    detectStatusCode(err) ?? inferStatusCodeFromBody(rawErrorBody);
  const provider = detectProvider(err);
  const requestId = detectRequestId(err);
  const { statusText, message } = describeHttpError(
    err,
    statusCode,
    extractedMessage,
    rawErrorBody,
  );
  // No status code on an unrecognized error likely means a network-level failure
  // (DNS, proxy, TLS, etc.) — show retry button for safety.
  const userRetryable =
    isRelay ||
    isCredentialExhausted ||
    (statusCode ? isRetryableStatusCode(statusCode) : true);

  return {
    ...classification,
    message: chatgptSubscriptionMessage ?? message,
    statusCode,
    statusText,
    provider,
    userRetryable,
    requestId,
  };
}

function detectCachedProviderError(err: unknown): ProviderError | undefined {
  return findInCauseChain(err, providerErrorMetadata.detect);
}

/**
 * Normalize an upstream or SDK error. If a structured `ProviderError` was
 * explicitly attached at a provider/flow boundary (possibly on a deeper
 * `cause`), recover it; otherwise format the error fresh. Retry code consumes
 * this helper so provider-boundary code owns classification while downstream
 * layers only read the shape.
 */
export function normalizeProviderError(err: unknown): ProviderError {
  const cached = detectCachedProviderError(err);
  if (cached) {
    // A cached error may have been attached before the legacy retryable/
    // exhaustion-flag migration ran (e.g. a resumed flow's raw persisted
    // `lastError`, which bypasses the schema-level migration on the resume
    // path) — run the same migration fresh errors get so callers never read
    // legacy field names off a cached value.
    const normalized = normalizeLegacyProviderErrorFields(
      cached,
    ) as ProviderError;
    // Migrate the normalized error from a deeper cause onto the wrapper so
    // later reads skip both the chain walk and this normalization.
    providerErrorMetadata.attach(err, normalized);
    return normalized;
  }

  // Compute fresh but DO NOT cache the result: a caller may format an error for
  // logging before later metadata (streamDiagnostics / partialText) is attached
  // to it, and a deliberately status-stripped wrapper (e.g. background-polling
  // 404) must not inherit a status cached by an incidental normalize on its
  // cause. Only explicit `attachProviderError` at provider/flow boundaries seeds
  // the cache the lookup above recovers.
  return formatProviderHttpError(err);
}

const TRANSPORT_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  for (
    let current: unknown = error;
    current != null && typeof current === 'object' && !seen.has(current);
    current = (current as { cause?: unknown }).cause
  ) {
    seen.add(current);
    chain.push(current);
  }
  return chain;
}

function detectRetryAfterMs(chain: readonly unknown[]): number | undefined {
  for (const current of chain) {
    const headers = (current as { headers?: HeaderBag }).headers;
    const explicitMs = getHeaderValue(headers, 'retry-after-ms');
    if (explicitMs !== undefined) {
      const ms = Number(explicitMs);
      if (Number.isFinite(ms) && ms >= 0) return ms;
    }

    const retryAfter = getHeaderValue(headers, 'retry-after');
    if (retryAfter === undefined) continue;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}

function detectRouteStatusCode(
  error: Error,
  chain: readonly unknown[],
): number | undefined {
  for (const current of chain) {
    const status = detectStatusCode(current);
    if (status !== undefined && status >= 100 && status <= 599) {
      return status;
    }
  }
  return normalizeProviderError(error).statusCode;
}

function detectRateLimitScope(
  error: Error,
  statusCode: number | undefined,
): 'model' | 'wire' | undefined {
  if (statusCode !== StatusCodes.TOO_MANY_REQUESTS) return undefined;
  const formatted = normalizeProviderError(error);
  return formatted.exhaustionReason !== undefined ||
    isRelayRequestLimitBody(formatted.rawErrorBody)
    ? 'wire'
    : 'model';
}

/** Whether a failure is a model-scoped provider rate limit. */
export function isModelRateLimitFailure(error: Error): boolean {
  const chain = causeChain(error);
  return (
    detectRateLimitScope(error, detectRouteStatusCode(error, chain)) === 'model'
  );
}

/** Classifies model-scoped rate limits for their own recovery gate. */
export function classifyModelRateLimitFailure(
  error: Error,
): { retryAfterMs?: number } | undefined {
  const chain = causeChain(error);
  return detectRateLimitScope(error, detectRouteStatusCode(error, chain)) ===
    'model'
    ? { retryAfterMs: detectRetryAfterMs(chain) }
    : undefined;
}

/**
 * Classify a failure that carries evidence about a shared wire route
 * (provider + credential + endpoint): transport failures, 5xx/408 server
 * failures. Credential-exhaustion 429s cool this shared route, while
 * model-specific 429 rate limits use a separate recovery scope.
 * Retryable failures outside this set (e.g. 409 conflicts) stay node-local —
 * a conflict does not imply the route is unhealthy. Relay 401s are also
 * deliberately absent: token refresh is single-flighted at the auth boundary
 * and repaired by each call's own reactive recovery, so cooling the route
 * would only serialize peers.
 */
export function classifyWireRouteFailure(
  error: Error,
): { retryAfterMs?: number } | undefined {
  const chain = causeChain(error);
  const candidates = chain.map((current) => {
    const candidate = current as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
    };
    return {
      code: typeof candidate.code === 'string' ? candidate.code : '',
      name: typeof candidate.name === 'string' ? candidate.name : '',
      message: typeof candidate.message === 'string' ? candidate.message : '',
    };
  });
  const hasStructuredUndiciFailure = candidates.some(({ code }) =>
    code.startsWith('UND_ERR_'),
  );
  const taggedTransportFailure = chain.some((current) => {
    const kind = detectSdkErrorMetadata(current)?.kind;
    return kind === 'connection' || kind === 'connection_timeout';
  });
  const transportFailure =
    taggedTransportFailure ||
    candidates.some(({ code, name, message }) => {
      if (
        TRANSPORT_ERROR_CODES.has(code) ||
        (code === 'UND_ERR_INFO' && /\b(?:stream )?timeout\b/i.test(message))
      ) {
        return true;
      }
      return (
        !hasStructuredUndiciFailure &&
        (/(?:Connection|Timeout)Error$/.test(name) ||
          /^(?:fetch failed|failed to fetch)$/i.test(message.trim()))
      );
    });
  // Per-element field reads with an HTTP range guard, so a wrapper's non-HTTP
  // numeric `code` (an errno, a gRPC status) cannot shadow a real status
  // deeper in the chain. The full normalizer is the fallback for statuses only
  // inferable from provider bodies (e.g. relay).
  const statusCode = detectRouteStatusCode(error, chain);
  const sharedRateLimit = detectRateLimitScope(error, statusCode) === 'wire';
  if (
    !sharedRateLimit &&
    statusCode !== StatusCodes.REQUEST_TIMEOUT &&
    (statusCode == null || statusCode < 500) &&
    !transportFailure
  ) {
    return undefined;
  }

  return { retryAfterMs: detectRetryAfterMs(chain) };
}

/** Whether repeating the same provider request can recover without user action. */
export function isProviderErrorAutoRetryable(err: unknown): boolean {
  if (isUserAbort(err) || isContextWindowError(err)) return false;

  const formatted = normalizeProviderError(err);
  return (
    formatted.userRetryable &&
    formatted.exhaustionReason === undefined &&
    formatted.statusCode !== StatusCodes.UNAUTHORIZED &&
    formatted.statusCode !== StatusCodes.FORBIDDEN
  );
}

export function getSdkErrorMessage(err: unknown): string {
  return normalizeProviderError(err).message;
}

/** Normalize an error into the `{ userRetryable, lastError }` pair every
 *  `execFallback`/failed-outcome branch attaches to its result. */
export function buildFailedRetryInfo(err: unknown): {
  userRetryable: boolean;
  lastError: RetryErrorInfo;
} {
  const formatted = normalizeProviderError(err);
  return {
    userRetryable: formatted.userRetryable,
    lastError: toRetryErrorInfo(formatted),
  };
}

/** Builds consistent error data for logging with MESSAGE_TYPES.ERROR. */
export function buildErrorLogData(
  err: unknown,
  context?: ErrorContext,
): ErrorLogData {
  const formatted = normalizeProviderError(err);
  const rawMessage = toErrorMessage(err);

  return {
    ...formatted,
    rawMessage: rawMessage !== formatted.message ? rawMessage : undefined,
    operation: context?.operation,
    model: context?.model,
  };
}
