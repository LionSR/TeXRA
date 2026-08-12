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

import {
  causeChain,
  findInCauseChain,
  isDiskFullError,
} from '../errorPredicates';
import { isContextWindowError, isUserAbort } from './errorPatterns';
import {
  detectPartialText,
  detectSdkErrorMetadata,
  detectStreamDiagnostics,
  hasManualRetryOnlyErrorMarker,
  providerErrorMetadata,
} from './errorMetadata';
import {
  type HeaderBag,
  detectProvider,
  detectRawErrorBody,
  detectRequestId,
  detectStatusCode,
  detectStatusText,
  errorBodyCandidates,
  getErrorClassNames,
  getHeaderValue,
  pickStringField,
  safeGetReasonPhrase,
} from './errorInspection';
import {
  getRelayRequestLimitReason,
  getRelayRequestLimitRetryAfterMs,
  inferStatusCodeFromBody,
  isModelScopedRateLimitBody,
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
  describeKimiCodeSubscriptionLimit,
  parseKimiCodeSubscriptionLimit,
} from './kimiCodeSubscriptionDetection';
import {
  describeGlmCodingPlanLimit,
  describeGlmCodingPlanRateLimit,
  isGlmCodingPlanRateLimit,
  parseGlmCodingPlanLimit,
} from './glmCodingPlanDetection';
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
  const bodyMessage = errorBodyCandidates(rawErrorBody)
    .map((candidate) => pickStringField(candidate, 'message'))
    .find((candidateMessage) => candidateMessage !== undefined);
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

/**
 * Resolve the status code to classify on. A detected non-error code (< 400) is
 * likely misleading (e.g. an SSE connection reporting 200 while the actual
 * error sits in the body), so an SDK-class fallback and then the body-inferred
 * code take precedence over it; the detected code remains the last resort.
 */
function resolveErrorStatusCode(
  detected: number | undefined,
  rawErrorBody: unknown,
  fallbackStatusCode?: number,
): number | undefined {
  const httpError =
    detected !== undefined && detected >= 400 ? detected : undefined;
  return (
    httpError ??
    fallbackStatusCode ??
    inferStatusCodeFromBody(rawErrorBody) ??
    detected
  );
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
  const statusCode = resolveErrorStatusCode(
    metadata?.statusCode ?? detectStatusCode(err),
    rawErrorBody,
    entry.fallbackStatusCode,
  );
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
  // Kimi Code (Moonshot coding-subscription) quota exhaustion — same pattern:
  // a credential exhaustion that disables the "Prefer Kimi Code" preference on
  // accept so dual-backend Kimi models re-route through the Moonshot API key.
  const kimiCodeSubscriptionLimit = parseKimiCodeSubscriptionLimit(
    err,
    rawErrorBody,
  );
  const isKimiCodeSubscriptionLimited = kimiCodeSubscriptionLimit !== null;
  const kimiCodeSubscriptionMessage = kimiCodeSubscriptionLimit
    ? describeKimiCodeSubscriptionLimit(kimiCodeSubscriptionLimit)
    : undefined;
  // GLM Coding Plan quota exhaustion — same pattern: a credential exhaustion
  // that turns off the Coding Plan toggle on accept so GLM requests re-route
  // through the regular pay-as-you-go endpoint.
  const glmCodingPlanLimit = parseGlmCodingPlanLimit(rawErrorBody);
  const isGlmCodingPlanLimited = glmCodingPlanLimit !== null;
  const glmCodingPlanMessage = glmCodingPlanLimit
    ? describeGlmCodingPlanLimit(glmCodingPlanLimit)
    : undefined;
  // GLM Coding Plan transient rate limit / overload (codes 1302/1305): surface
  // a clear "retry in a moment" message, but keep it retryable — it is NOT a
  // quota exhaustion, so no switch-to-regular-endpoint affordance.
  const glmCodingPlanRateLimitMessage = isGlmCodingPlanRateLimit(rawErrorBody)
    ? describeGlmCodingPlanRateLimit()
    : undefined;
  // Prefer the actionable subscription-limit message over the raw
  // `HTTP 429 – The usage limit has been reached`.
  const subscriptionLimitMessage =
    chatgptSubscriptionMessage ??
    kimiCodeSubscriptionMessage ??
    glmCodingPlanMessage ??
    glmCodingPlanRateLimitMessage;
  // Priority mirrors the pre-refactor OR order: ChatGPT-subscription and
  // upstream-credit are independently detected first; relay monthly limit
  // (by body or message) is the remaining exhaustion condition. Explicit SDK
  // metadata precedes these legacy body heuristics.
  let exhaustionReason: ExhaustionReason | undefined = sdkExhaustionReason;
  if (exhaustionReason === undefined) {
    if (isChatGptSubscriptionLimited) {
      exhaustionReason = 'chatgpt-subscription';
    } else if (isKimiCodeSubscriptionLimited) {
      exhaustionReason = 'kimi-code-subscription';
    } else if (isGlmCodingPlanLimited) {
      exhaustionReason = 'glm-coding-plan';
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
  const overflowStatusCode = resolveErrorStatusCode(
    detectStatusCode(err),
    rawErrorBody,
  );
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
      message: subscriptionLimitMessage ?? sdkMatch.message,
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
    message: subscriptionLimitMessage ?? message,
    statusCode,
    statusText,
    provider,
    userRetryable,
    requestId,
  };
}

/**
 * Normalize an upstream or SDK error. If a structured `ProviderError` was
 * explicitly attached at a provider/flow boundary (possibly on a deeper
 * `cause`), recover it; otherwise format the error fresh. Retry code consumes
 * this helper so provider-boundary code owns classification while downstream
 * layers only read the shape.
 */
export function normalizeProviderError(err: unknown): ProviderError {
  const cached = findInCauseChain(err, providerErrorMetadata.detect);
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
): 'model' | 'relay-limit' | 'relay-user' | 'wire' | undefined {
  if (statusCode !== StatusCodes.TOO_MANY_REQUESTS) return undefined;
  const formatted = normalizeProviderError(error);
  if (
    formatted.isRelayError &&
    isRelayRequestLimitBody(formatted.rawErrorBody)
  ) {
    return 'relay-user';
  }
  if (formatted.exhaustionReason === 'relay-limit') return 'relay-limit';
  if (formatted.exhaustionReason !== undefined) return 'wire';
  return isModelScopedRateLimitBody(formatted.rawErrorBody) ? 'model' : 'wire';
}

/** Whether a failure is a model-scoped provider rate limit. */
export function isModelRateLimitFailure(error: Error): boolean {
  return classifyModelRateLimitFailure(error) !== undefined;
}

/** Classifies model-scoped rate limits for their own recovery gate. */
export function classifyModelRateLimitFailure(
  error: Error,
): { retryAfterMs?: number } | undefined {
  const chain = causeChain(error);
  const scope = detectRateLimitScope(
    error,
    detectRouteStatusCode(error, chain),
  );
  if (scope !== 'model') return undefined;
  return { retryAfterMs: detectRetryAfterMs(chain) };
}

/** Whether an upstream rate limit proves the relay request gate admitted the call. */
export function isRelayRequestGateReachableFailure(error: Error): boolean {
  const chain = causeChain(error);
  const statusCode = detectRouteStatusCode(error, chain);
  const scope = detectRateLimitScope(error, statusCode);
  return (
    statusCode === StatusCodes.TOO_MANY_REQUESTS &&
    scope !== 'relay-limit' &&
    scope !== 'relay-user'
  );
}

/** Whether a relay admission boundary rejected the call before the provider. */
export function isRelayProviderUnobservedFailure(error: Error): boolean {
  const chain = causeChain(error);
  const scope = detectRateLimitScope(
    error,
    detectRouteStatusCode(error, chain),
  );
  return scope === 'relay-limit' || scope === 'relay-user';
}

/** Whether the relay rejected the call before its per-user request gate. */
export function isRelayRequestGateUnobservedFailure(error: Error): boolean {
  return normalizeProviderError(error).exhaustionReason === 'relay-limit';
}

/** Classifies relay request limits for their cross-provider recovery gate. */
export function classifyRelayRequestLimitFailure(error: Error):
  | {
      retryAfterMs?: number;
      releaseProbeBeforeOperation?: boolean;
    }
  | undefined {
  const chain = causeChain(error);
  if (
    detectRateLimitScope(error, detectRouteStatusCode(error, chain)) !==
    'relay-user'
  ) {
    return undefined;
  }
  const formatted = normalizeProviderError(error);
  const headerDelay = detectRetryAfterMs(chain);
  const bodyDelay = getRelayRequestLimitRetryAfterMs(formatted.rawErrorBody);
  const retryAfterMs =
    headerDelay === undefined && bodyDelay === undefined
      ? undefined
      : Math.max(headerDelay ?? 0, bodyDelay ?? 0);
  return {
    retryAfterMs,
    ...(getRelayRequestLimitReason(formatted.rawErrorBody) === 'rate'
      ? { releaseProbeBeforeOperation: true }
      : {}),
  };
}

/**
 * Classify a failure that carries evidence about a shared wire route
 * (provider + credential + endpoint): transport failures, 5xx/408 server
 * failures and provider rate limits without explicit model scope. Provider
 * bodies that identify a model-specific limit or the relay's per-user request
 * gate use their own recovery scopes.
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

/** Whether a normalized provider error is a 401 (relay/auth token rejected). */
export function isUnauthorizedProviderError(formatted: ProviderError): boolean {
  return formatted.statusCode === StatusCodes.UNAUTHORIZED;
}

/** Whether repeating the same provider request can recover without user action. */
export function isProviderErrorAutoRetryable(err: unknown): boolean {
  if (
    isUserAbort(err) ||
    isContextWindowError(err) ||
    hasManualRetryOnlyErrorMarker(err)
  ) {
    return false;
  }

  const formatted = normalizeProviderError(err);
  return (
    formatted.userRetryable &&
    formatted.exhaustionReason === undefined &&
    !isUnauthorizedProviderError(formatted) &&
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
