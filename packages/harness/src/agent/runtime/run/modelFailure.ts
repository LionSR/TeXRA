/**
 * The runtime's reading of a failed model attempt. The package judges every
 * failure its binding raises against the vendor's reply (`ModelError`'s
 * kind, status, `retryable`, `scope` and `quota`); this module only turns
 * that verdict into the retry policy, the route verdict and the copy of the
 * manual-retry prompt. A failure that is not the package's (a credential the
 * route could not resolve, a cancelled request) is formatted as any error.
 */
import { StatusCodes } from 'http-status-codes';
import { Data } from 'effect';
import { ModelError } from '@texra-ai/llm';

import {
  attachContextWindowError,
  attachProviderError,
} from '@common/errors/sdkError/errorMetadata';
import {
  detectRawErrorBody,
  safeGetReasonPhrase,
} from '@common/errors/sdkError/errorInspection';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import {
  formatResetDuration,
  isProviderErrorAutoRetryable,
  normalizeProviderError,
  httpErrorMessage,
} from '@common/errors/sdkError/providerErrorFormat';
import { isRetryableStatusCode } from '@common/errors/sdkError/sdkErrorKinds';
import { quotaFallbackRouteFor } from '@shared/quotaFallbackRoutes';
import {
  getExhaustionReason,
  toRetryErrorInfo,
  type ExhaustionReason,
  type ProviderError,
  type ProviderErrorClassification,
  type RetryErrorInfo,
} from '@shared/schemas';
import { capitalize } from '@utils/text/stringUtils';
import { ensureError } from '@utils/errors/errorMessage';

import type { RoutePolicy } from '../ModelRetryGate';
import type { BoundModel } from './modelBinding';

/** What a failure's reading needs of its binding: the provider it names. */
type Bound = { readonly config: Pick<BoundModel['config'], 'provider'> };

/**
 * What one failed model call proves about the recovery routes it ran under.
 * Every route asks a different question of the same failure — the shared wire
 * route and the model-specific limit scope — so the call site classifies once
 * and reads the verdict.
 */
interface ModelRouteVerdict {
  /** The scope that owns the limit. Defined only for a 429. */
  readonly rateLimitScope: 'model' | 'wire' | undefined;
  /** Credential exhaustion (subscription quota, upstream credit). */
  readonly exhaustionReason: ExhaustionReason | undefined;
  /**
   * The failure carries evidence about a shared wire route (provider +
   * credential + endpoint): a transport failure with network evidence, a
   * 5xx/408 server failure, or a rate limit without an explicit model scope —
   * that one uses its own recovery scope. A 409, retryable per request, stays
   * node-local: a conflict does not imply the route is unhealthy.
   */
  readonly wireRouteFailure: boolean;
  /** The provider's own `retry-after` guidance, as the package read it. */
  readonly retryAfterMs: number | undefined;
}

export interface ModelFailure {
  /** The error the runtime policies read: the SDK cause when there is one. */
  readonly error: Error;
  readonly formatted: ProviderError;
  readonly info: RetryErrorInfo;
  readonly autoRetryable: boolean;
  readonly verdict: ModelRouteVerdict;
  /** A chained request's stored response is missing or past retention. */
  readonly storedResponseGone: boolean;
}

/** The exhaustion reason a quota verdict names: its plan's, else the account's credit. */
function exhaustionOf(
  quota: ModelError['quota'],
): ExhaustionReason | undefined {
  if (quota === undefined) return undefined;
  if (quota.plan === null) return 'upstream-credit';
  return quotaFallbackRouteFor(quota.plan).exhaustionReason;
}

/** The retry panel's classification: an overflowed window, or a used-up credential. */
function classificationOf(
  failed: ModelError,
  exhaustion: ExhaustionReason | undefined,
): ProviderErrorClassification | undefined {
  if (failed.kind === 'context-overflow') return { kind: 'context-window' };
  return exhaustion === undefined ? undefined : { kind: exhaustion };
}

/** Which route a 429 cools: the model's, where the provider scoped it, else the wire's. */
function rateLimitScope(
  failed: ModelError,
): ModelRouteVerdict['rateLimitScope'] {
  if (failed.status !== StatusCodes.TOO_MANY_REQUESTS) return undefined;
  return failed.scope === 'model' ? 'model' : 'wire';
}

/**
 * The copy of a package failure. A used-up plan names the switch the retry
 * offers, from the same catalog entry; an overflowed window says why a retry
 * cannot help; anything else is the reply's message under its status.
 */
function failureMessage(error: ModelError): string {
  const { quota } = error;
  if (quota !== undefined && quota.plan !== null) {
    const route = quotaFallbackRouteFor(quota.plan);
    const plan = quota.planType ? ` (${capitalize(quota.planType)} plan)` : '';
    const reset =
      quota.resetsInMs === undefined
        ? ''
        : ` Resets in ${formatResetDuration(quota.resetsInMs / 1000)}.`;
    return (
      `${route.retrySourceName} usage limit reached${plan}.${reset}` +
      ` Switch to ${route.retryFallbackName} to keep working, or wait until the limit resets.`
    );
  }
  if (error.kind === 'context-overflow')
    return (
      `${error.message} Retrying would resend the same oversized request. ` +
      'Start a new session, or reduce attached files and tool output.'
    );
  // An empty message: the reply explained nothing it is safe to show.
  const reason =
    error.status === undefined ? undefined : safeGetReasonPhrase(error.status);
  return httpErrorMessage(
    error.status,
    error.message || reason || 'Provider request failed',
  );
}

/**
 * Whether the retry panel offers a retry. A used-up plan does, with its
 * switch; an overflowed window never does; otherwise the status decides, and
 * without one only a reply the package could not explain is refused.
 */
function offersRetry(error: ModelError): boolean {
  if (error.kind === 'quota-exhausted') return true;
  if (error.kind === 'context-overflow') return false;
  if (error.status !== undefined) return isRetryableStatusCode(error.status);
  return error.kind === 'provider-rejection' ||
    error.kind === 'continuation-gone'
    ? error.retryable
    : true;
}

/** The package's verdict on a failure, as the runtime's retry and route policy reads it. */
function packageFailure(
  failed: ModelError,
  bound: Bound,
  partialText: string | undefined,
): ModelFailure {
  const error = failed.cause instanceof Error ? failed.cause : failed;
  if (failed.kind === 'context-overflow') attachContextWindowError(error);
  const exhaustionReason = exhaustionOf(failed.quota);
  const classification = classificationOf(failed, exhaustionReason);
  const { status } = failed;
  const statusText =
    status === undefined ? undefined : safeGetReasonPhrase(status);
  const rawErrorBody = detectRawErrorBody(error);
  const formatted: ProviderError = {
    message: failureMessage(failed),
    provider: bound.config.provider,
    userRetryable: offersRetry(failed),
    ...(status !== undefined ? { statusCode: status } : {}),
    ...(statusText !== undefined ? { statusText } : {}),
    ...(classification !== undefined ? { classification } : {}),
    ...(failed.requestId !== undefined ? { requestId: failed.requestId } : {}),
    ...(rawErrorBody !== undefined ? { rawErrorBody } : {}),
    ...(partialText !== undefined && partialText !== '' ? { partialText } : {}),
  };
  return {
    error,
    formatted,
    autoRetryable: failed.retryable && !isUserAbort(error),
    storedResponseGone: failed.kind === 'continuation-gone',
    verdict: {
      rateLimitScope: rateLimitScope(failed),
      exhaustionReason,
      wireRouteFailure: failed.scope === 'route',
      retryAfterMs: failed.retryAfterMs,
    },
    info: toRetryErrorInfo(formatted),
  };
}

/** A failure the package did not raise, formatted as any error. */
function localFailure(
  cause: unknown,
  bound: Bound,
  partialText: string | undefined,
): ModelFailure {
  const error = ensureError(cause);
  const normalized = normalizeProviderError(error);
  const formatted: ProviderError = {
    ...normalized,
    provider: bound.config.provider,
    ...(partialText !== undefined && partialText !== '' ? { partialText } : {}),
  };
  const { statusCode } = formatted;
  return {
    error,
    formatted,
    autoRetryable: isProviderErrorAutoRetryable(error),
    storedResponseGone: false,
    verdict: {
      rateLimitScope:
        statusCode === StatusCodes.TOO_MANY_REQUESTS ? 'wire' : undefined,
      exhaustionReason: getExhaustionReason(formatted),
      wireRouteFailure:
        statusCode === StatusCodes.TOO_MANY_REQUESTS ||
        statusCode === StatusCodes.REQUEST_TIMEOUT ||
        (statusCode !== undefined && statusCode >= 500),
      retryAfterMs: undefined,
    },
    info: toRetryErrorInfo(formatted),
  };
}

/**
 * Reads a failed attempt on `bound`. `partialText` is the tail of the text
 * the attempt had already streamed: the one producer of the field the retry
 * surface shows, now that the loop rather than a provider handler is what
 * watches the stream. The classification is cached on the error, so every
 * later reader (the run lifecycle's terminal classification included)
 * recovers this same shape.
 */
export function classifyModelFailure(
  cause: unknown,
  bound: Bound,
  partialText?: string,
): ModelFailure {
  const failure =
    cause instanceof ModelError
      ? packageFailure(cause, bound, partialText)
      : localFailure(cause, bound, partialText);
  attachProviderError(failure.error, failure.formatted);
  return failure;
}

/** A failed attempt's classification; the rows it left are its driver's. */
export class AttemptFailed extends Data.TaggedError('AttemptFailed')<{
  readonly failure: ModelFailure;
}> {
  override get message(): string {
    return this.failure.formatted.message;
  }
}

/**
 * The retry gate's two routes for one binding, narrowest first: the model on
 * its wire route, then the wire route (provider, credential, endpoint).
 */
export function routePolicies(bound: BoundModel): [RoutePolicy, RoutePolicy] {
  const verdictOf = (error: Error) =>
    error instanceof AttemptFailed
      ? error.failure.verdict
      : classifyModelFailure(error, bound).verdict;
  return [
    {
      key: bound.modelRetryRouteKey,
      classifyFailure: (error) => {
        const verdict = verdictOf(error);
        return verdict.rateLimitScope === 'model'
          ? { retryAfterMs: verdict.retryAfterMs }
          : undefined;
      },
    },
    {
      key: bound.wireRouteKey,
      classifyFailure: (error) => {
        const verdict = verdictOf(error);
        return verdict.wireRouteFailure
          ? { retryAfterMs: verdict.retryAfterMs }
          : undefined;
      },
      isReachableFailure: (error) =>
        verdictOf(error).rateLimitScope === 'model',
    },
  ];
}
