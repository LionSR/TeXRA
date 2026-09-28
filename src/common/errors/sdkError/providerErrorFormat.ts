import stableStringify from 'safe-stable-stringify';
import { StatusCodes } from 'http-status-codes';
import prettyMilliseconds from 'pretty-ms';

import { Result } from 'effect';
import { safeParseJson } from '@common/parsing/safeParseJson';
import {
  type QuotaFallbackExhaustionReason,
  QUOTA_FALLBACK_ROUTES,
} from '@shared/quotaFallbackRoutes';
import {
  type ErrorContext,
  type ErrorLogData,
  type ExhaustionReason,
  type ProviderError,
  type ProviderErrorClassification,
  type UsageRoute,
  getExhaustionReason,
} from '@shared/schemas';
import {
  extractErrorMessage,
  toErrorMessage,
} from '@utils/errors/errorMessage';
import { capitalize } from '@utils/text/stringUtils';

import { findInCauseChain, isDiskFullError } from '../errorPredicates';
import { isContextWindowError, isUserAbort } from './errorPatterns';
import {
  detectSdkUsageRoute,
  hasContextWindowErrorMarker,
  hasMissingApiKeyErrorMarker,
  providerErrorMetadata,
} from './errorMetadata';
import {
  detectRawErrorBody,
  detectStatusCode,
  detectStatusText,
  firstBodyStringField,
  inferStatusCodeFromBody,
  matchUsageLimitMessage,
  isUpstreamCreditDepletedBody,
  safeGetReasonPhrase,
  type QuotaLimitInfo,
} from './errorInspection';
import { parseChatGptSubscriptionLimit } from './chatgptSubscriptionDetection';
import {
  describeGlmCodingPlanRateLimit,
  isGlmCodingPlanRateLimit,
  parseGlmCodingPlanLimit,
} from './glmCodingPlanDetection';
import { isRetryableStatusCode } from './sdkErrorKinds';

interface QuotaLimitMatch {
  readonly exhaustionReason: ExhaustionReason;
  readonly message: string;
}

/**
 * A subscription usage-limit parser guarded by the credential route the run
 * stamped on the failure. Route stamp plus body inspection, no clock reads:
 * the plan's endpoint is shared with the API-key path, so the stamp is what
 * keeps a direct-key rate limit from being read as plan exhaustion.
 */
const routeUsageLimit =
  (route: UsageRoute, pattern: RegExp) =>
  (err: unknown, rawErrorBody: unknown): QuotaLimitInfo | null =>
    detectSdkUsageRoute(err) === route
      ? matchUsageLimitMessage(err, rawErrorBody, pattern)
      : null;

/**
 * Quota-limit body parsers, keyed by the catalog's exhaustion reason. Total
 * over {@link QuotaFallbackExhaustionReason}, so a fifth `QUOTA_FALLBACK_ROUTES`
 * entry fails to compile until its detector lands rather than shipping a
 * switchable route with no error copy.
 */
const QUOTA_LIMIT_PARSERS: Record<
  QuotaFallbackExhaustionReason,
  (err: unknown, rawErrorBody: unknown) => QuotaLimitInfo | null
> = {
  'chatgpt-subscription': (_err, rawErrorBody) =>
    parseChatGptSubscriptionLimit(rawErrorBody),
  /*
   * Detection for the Grok (xAI SuperGrok) subscription usage limit. SuperGrok
   * hits the same `api.x.ai` surface as an API key, so the bound credential
   * route the run stamped on the failure is the only reliable "this was a
   * subscription call" signal. Combined with quota/usage-limit wording (and not
   * a transient rate-limit phrase) that identifies a plan whose quota ran out —
   * the signal that lets the retry UI offer a switch to the stored xAI API key.
   * Transient 429 rate limits ("rate limit", "too many requests") do not match
   * and must not flip the preference.
   */
  'xai-subscription': routeUsageLimit(
    'xai-subscription',
    /usage limit|quota.{0,24}(exceeded|exhausted|reached)|exceeded your (usage|quota)|weekly (usage )?limit|monthly (usage )?limit/i,
  ),
  /*
   * Detection for the Kimi Code (Moonshot coding-subscription) usage limit.
   * When a user drives Kimi-subscription-eligible models through their Kimi
   * Code membership (the `api.kimi.com/coding/v1` coding endpoint), the backend
   * rejects requests once the membership's usage quota is exhausted with a
   * distinctive message:
   *
   *   "You've reached your usage limit for this billing cycle. Your quota will
   *    be refreshed in the next cycle. To continue now, purchase extra usage or
   *    upgrade your plan: https://www.kimi.com/code/#pricing"
   *
   * The "usage limit for this billing cycle" / "quota will be refreshed in the
   * next cycle" phrasing is unique to the Kimi Code membership backend, so
   * matching it reliably identifies a subscription request whose quota ran
   * out — the signal that lets the retry UI offer "switch to your own API key"
   * (parallel to the Codex `usage_limit_reached` affordance). The bound
   * credential route keeps the Moonshot open platform from being misread as a
   * subscription limit.
   */
  'kimi-code-subscription': routeUsageLimit(
    'kimi-code-subscription',
    /usage limit for this billing cycle|quota will be refreshed in the next cycle/i,
  ),
  'glm-coding-plan': (_err, rawErrorBody) =>
    parseGlmCodingPlanLimit(rawErrorBody),
};

/**
 * Format a coarse "1d 20h" / "20h 22m" / "5m" duration from a second count.
 * Day+hour, hour+minute, or minute granularity is plenty for a reset-window
 * hint; sub-minute collapses to a friendly phrase. Pure (no clock read), so it
 * stays usable from this synchronous formatter. Backed by `pretty-ms` (top 2
 * units) rather than hand-rolled day/hour/minute math — minutes are truncated
 * once the duration reaches a day, matching the "day granularity drops
 * minutes" rule of the original hand-rolled formatter (pretty-ms would
 * otherwise back-fill a zero hour component with minutes, e.g. "1d 58m").
 */
function formatResetDuration(totalSeconds: number): string {
  const wholeMinutes = Math.floor(Math.max(0, totalSeconds) / 60);
  if (wholeMinutes === 0) return 'less than a minute';
  const flooredMinutes =
    wholeMinutes >= 1440 ? wholeMinutes - (wholeMinutes % 60) : wholeMinutes;
  return prettyMilliseconds(flooredMinutes * 60_000, { unitCount: 2 });
}

/**
 * First matching quota-fallback detector, walked in catalog order (ChatGPT,
 * Grok, then coding plans). Reasons are mutually exclusive, so the first hit is
 * the only hit. The sentence is built from the matched route's own noun
 * phrases, so the retry copy can never name a different source or fallback
 * than the preference switch the user is about to accept.
 */
function detectQuotaLimit(
  err: unknown,
  rawErrorBody: unknown,
): QuotaLimitMatch | undefined {
  for (const route of QUOTA_FALLBACK_ROUTES) {
    const info = QUOTA_LIMIT_PARSERS[route.exhaustionReason](err, rawErrorBody);
    if (!info) continue;
    const plan = info.planType ? ` (${capitalize(info.planType)} plan)` : '';
    const reset =
      info.resetsInSeconds !== undefined
        ? ` Resets in ${formatResetDuration(info.resetsInSeconds)}.`
        : '';
    return {
      exhaustionReason: route.exhaustionReason,
      message:
        `${route.retrySourceName} usage limit reached${plan}.${reset}` +
        ` Switch to ${route.retryFallbackName} to keep working, or wait until the limit resets.`,
    };
  }
  return undefined;
}

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
  const bodyMessage = firstBodyStringField(rawErrorBody, 'message');
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
      // Non-serializable diagnostic bodies cannot have been JSON-stringified
      // into the SDK wrapper message by the path guarded here.
      const serialized = Result.try(() => JSON.stringify(rawErrorBody));
      if (Result.isSuccess(serialized) && serialized.success !== undefined) {
        wrapperMessageContainsRawBody =
          serialized.success.length > 2 &&
          extractedMessage.includes(serialized.success);
      }

      if (!wrapperMessageContainsRawBody) {
        const opening = Array.isArray(rawErrorBody) ? '[' : '{';
        const closing = Array.isArray(rawErrorBody) ? ']' : '}';
        const start = extractedMessage.indexOf(opening);
        const end = extractedMessage.lastIndexOf(closing);
        if (start >= 0 && end > start) {
          const embeddedBody = Result.getOrUndefined(
            safeParseJson(extractedMessage.slice(start, end + 1)),
          );
          // Circular or otherwise non-JSON diagnostics cannot match a JSON
          // fragment parsed from the wrapper message.
          wrapperMessageContainsRawBody = Result.getOrElse(
            Result.try(
              () =>
                stableStringify(embeddedBody) === stableStringify(rawErrorBody),
            ),
            () => false,
          );
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

/**
 * Builds a fresh `ProviderError` without caching it on the thrown value.
 *
 * @internal Production code should call {@link normalizeProviderError}, the
 * single public entry that classifies once and caches the result on the
 * error. This stays module-exported for tests that assert raw formatting.
 */
export function formatProviderHttpError(err: unknown): ProviderError {
  const rawErrorBody = detectRawErrorBody(err);
  const extractedMessage = extractErrorMessage(err);
  // Credit exhaustion wants the "Use your own API key" affordance so the
  // user can switch credentials — e.g. a direct Anthropic 400 "credit
  // balance is too low".
  const isUpstreamCreditDepleted = isUpstreamCreditDepletedBody(rawErrorBody);
  const quotaLimit = detectQuotaLimit(err, rawErrorBody);
  // GLM Coding Plan transient rate limit / overload (codes 1302/1305): surface
  // a clear "retry in a moment" message, but keep it retryable — it is NOT a
  // quota exhaustion, so no switch-to-regular-endpoint affordance.
  const glmCodingPlanRateLimitMessage = isGlmCodingPlanRateLimit(rawErrorBody)
    ? describeGlmCodingPlanRateLimit()
    : undefined;
  // Prefer the actionable subscription-limit message over the raw
  // `HTTP 429 – The usage limit has been reached`.
  const subscriptionLimitMessage =
    quotaLimit?.message ?? glmCodingPlanRateLimitMessage;
  // Priority: the first matching quota-fallback detector, then upstream-credit.
  const exhaustionReason: ExhaustionReason | undefined =
    quotaLimit?.exhaustionReason ??
    (isUpstreamCreditDepleted ? 'upstream-credit' : undefined);
  const isCredentialExhausted = exhaustionReason !== undefined;
  const hasMissingApiKey = hasMissingApiKeyErrorMarker(err);
  let markerClassification: ProviderErrorClassification | undefined;
  if (hasMissingApiKey) {
    markerClassification = { kind: 'missing-api-key' };
  } else if (hasContextWindowErrorMarker(err)) {
    markerClassification = { kind: 'context-window' };
  } else if (exhaustionReason !== undefined) {
    markerClassification = { kind: exhaustionReason };
  }

  // Terminal failures (user abort, local disk-full): never retryable and never
  // a credential affordance. Carries the raw body but deliberately opts
  // out of the credential classification computed below.
  function terminalError(
    message: string,
    classification?: ProviderErrorClassification,
  ): ProviderError {
    return {
      message,
      userRetryable: false,
      classification,
      rawErrorBody,
    };
  }

  // An AbortController abort or an SDK user-abort error.
  if (isUserAbort(err)) {
    return terminalError('Request aborted');
  }

  // Disk full — local I/O error, no retry will help
  if (isDiskFullError(err)) {
    return terminalError(
      'No space left on device. Free up disk space and try again.',
    );
  }

  // The status this error resolves to, shared by the context-window guard and
  // the return below. Routed through the shared resolver so a misleading
  // sub-400 code (an SSE 200, a wrapper's errno) cannot outrank a status
  // inferable from the body.
  const statusCode = resolveErrorStatusCode(
    detectStatusCode(err),
    rawErrorBody,
  );

  // Context-window overflow — deterministic: a retry resends the same
  // oversized payload and fails again. Handler-level recovery (compaction,
  // dropping previous_response_id) runs before the error reaches this
  // classifier, so an overflow that arrives here is terminal for this turn.
  // Guarded on the status code because isContextWindowError also matches by
  // message wording, and a retryable provider error (e.g. a 429 mentioning
  // tokens) must keep its retry affordance.
  if (
    isContextWindowError(err) &&
    (statusCode === undefined || !isRetryableStatusCode(statusCode))
  ) {
    return terminalError(
      `${extractedMessage ?? 'Conversation exceeds the model context window.'} ` +
        'Retrying would resend the same oversized request. Start a new ' +
        'session, or reduce attached files and tool output.',
      hasMissingApiKey
        ? { kind: 'missing-api-key' }
        : { kind: 'context-window' },
    );
  }

  const { statusText, message } = describeHttpError(
    err,
    statusCode,
    extractedMessage,
    rawErrorBody,
  );
  // No status code likely means a network-level failure (DNS, proxy, TLS,
  // etc.) — show retry button for safety. Credential-exhausted errors keep
  // userRetryable=true so the retry panel surfaces with the "Use your own API
  // key" affordance, but shouldAutoRetry separately suppresses auto-retry for
  // them — a fresh attempt with the same depleted credential would just fail.
  const userRetryable =
    isCredentialExhausted ||
    (statusCode ? isRetryableStatusCode(statusCode) : true);

  return {
    classification: markerClassification,
    rawErrorBody,
    message: subscriptionLimitMessage ?? message,
    statusCode,
    statusText,
    userRetryable,
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
    // Cache metadata is canonical and validated by providerErrorMetadata.
    // Copy a value found on a deeper cause onto the wrapper so later reads can
    // skip the cause-chain walk.
    providerErrorMetadata.attach(err, cached);
    return cached;
  }

  // Compute fresh but DO NOT cache the result: a caller may format an error
  // for logging before the route stamp is attached to it, and a deliberately
  // status-stripped wrapper (e.g. background-polling 404) must not inherit a
  // status cached by an incidental normalize on its cause. Only explicit
  // `attachProviderError` at provider/flow boundaries seeds the cache the
  // lookup above recovers.
  return formatProviderHttpError(err);
}

/** Whether repeating the same provider request can recover without user action. */
export function isProviderErrorAutoRetryable(err: unknown): boolean {
  if (isUserAbort(err) || isContextWindowError(err)) {
    return false;
  }

  const formatted = normalizeProviderError(err);
  return (
    formatted.userRetryable &&
    getExhaustionReason(formatted) === undefined &&
    formatted.statusCode !== StatusCodes.UNAUTHORIZED &&
    formatted.statusCode !== StatusCodes.FORBIDDEN
  );
}

export function getSdkErrorMessage(err: unknown): string {
  return normalizeProviderError(err).message;
}

/** Builds consistent error data for logging with MESSAGE_TYPES.ERROR. */
export function buildErrorLogData(
  err: unknown,
  context?: ErrorContext,
): ErrorLogData {
  const { rawErrorBody: _body, ...formatted } = normalizeProviderError(err);
  const rawMessage = toErrorMessage(err);

  return {
    ...formatted,
    rawMessage: rawMessage !== formatted.message ? rawMessage : undefined,
    operation: context?.operation,
    model: context?.model,
  };
}
