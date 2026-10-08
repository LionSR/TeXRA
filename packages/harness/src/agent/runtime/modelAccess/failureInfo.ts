/**
 * What a failed model call means to the person and to the retry gate. llm
 * judges every vendor failure (`ModelError`'s kind, `retryable`, `scope`,
 * `retryAfterMs`, `quota`); model access fails with `RouteUnavailable`. This
 * module only words either for the retry request a run records and reads
 * the scope the gate cools.
 */
import { StatusCodes } from 'http-status-codes';
import { String as Str } from 'effect';
import { ModelError } from '@texra-ai/llm';

import type { RoutePolicy } from '@agent/runtime/ModelRetryGate';
import type { RouteUnavailable } from '@common/errors/agentErrors';
import {
  formatResetDuration,
  httpErrorMessage,
  safeGetReasonPhrase,
} from '@common/errors/sdkError/providerErrorFormat';
import { quotaFallbackRouteFor } from '@shared/quotaFallbackRoutes';
import type {
  ExhaustionReason,
  ProviderErrorClassification,
  RetryErrorInfo,
} from '@shared/schemas';

/** Why a model call failed: the vendor's verdict, or no route to send it on. */
export type CallFailure = ModelError | RouteUnavailable;

/** The exhaustion a quota verdict names: its plan's, else the account's credit. */
function exhaustionOf(error: ModelError): ExhaustionReason | undefined {
  const { quota } = error;
  if (quota === undefined) return undefined;
  if (quota.plan === null) return 'upstream-credit';
  return quotaFallbackRouteFor(quota.plan).exhaustionReason;
}

/** The retry panel's classification: an overflowed window, a used-up credential, a missing key. */
function classificationOf(
  error: CallFailure,
): ProviderErrorClassification | undefined {
  if (!(error instanceof ModelError)) {
    return error.reason === 'missing-api-key'
      ? { kind: 'missing-api-key' }
      : undefined;
  }
  if (error.kind === 'context-overflow') return { kind: 'context-window' };
  const exhaustion = exhaustionOf(error);
  return exhaustion === undefined ? undefined : { kind: exhaustion };
}

/**
 * The copy of a vendor failure. A used-up plan names the switch the retry
 * offers; an overflowed window says why a retry cannot help; anything else
 * is the reply's message under its status.
 */
function failureMessage(error: ModelError): string {
  const { quota } = error;
  if (quota !== undefined && quota.plan !== null) {
    const route = quotaFallbackRouteFor(quota.plan);
    const plan = quota.planType
      ? ` (${Str.capitalize(quota.planType)} plan)`
      : '';
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
  const reason =
    error.status === undefined ? undefined : safeGetReasonPhrase(error.status);
  return httpErrorMessage(
    error.status,
    error.message || reason || 'Provider request failed',
  );
}

/**
 * Whether a person is offered a retry after `error`: whenever llm says the
 * same request can succeed, and after a used-up plan, whose retry carries
 * the switch onto the user's own credential. A missing route is fixed
 * outside the run, so its retry is never offered.
 */
export function offersRetry(error: CallFailure): boolean {
  if (!(error instanceof ModelError)) return false;
  return error.retryable || error.kind === 'quota-exhausted';
}

/**
 * The failure a run records for `error` on a binding of `provider`.
 * `partialText` is the tail of the text the attempt had streamed, which the
 * retry surface shows; an `unsent` failure (a rebind or renewal that failed)
 * is never offered again, so the user reads why.
 */
export function failureInfo(
  error: CallFailure,
  provider: string,
  options: { readonly partialText?: string; readonly unsent?: boolean } = {},
): RetryErrorInfo {
  const status = error instanceof ModelError ? error.status : undefined;
  const statusText =
    status === undefined ? undefined : safeGetReasonPhrase(status);
  const classification = classificationOf(error);
  const requestId = error instanceof ModelError ? error.requestId : undefined;
  return {
    message:
      error instanceof ModelError ? failureMessage(error) : error.message,
    provider,
    userRetryable: options.unsent !== true && offersRetry(error),
    ...(status !== undefined && { statusCode: status }),
    ...(statusText !== undefined && { statusText }),
    ...(classification !== undefined && { classification }),
    ...(requestId !== undefined && { requestId }),
    ...(options.partialText ? { partialText: options.partialText } : {}),
  };
}

/** Which route a 429 cools: the model's, where the provider scoped it, else the wire's. */
const modelScoped = (error: Error): boolean =>
  error instanceof ModelError &&
  error.status === StatusCodes.TOO_MANY_REQUESTS &&
  error.scope === 'model';

/**
 * The retry gate's two routes for one binding, narrowest first: the model on
 * its wire route, then the wire route (provider, credential, endpoint),
 * which a failure llm scoped to the route cools.
 */
export function routePolicies(bound: {
  readonly modelRetryRouteKey: string;
  readonly wireRouteKey: string;
}): [RoutePolicy, RoutePolicy] {
  const after = (error: Error) => ({
    retryAfterMs: error instanceof ModelError ? error.retryAfterMs : undefined,
  });
  return [
    {
      key: bound.modelRetryRouteKey,
      classifyFailure: (error) =>
        modelScoped(error) ? after(error) : undefined,
    },
    {
      key: bound.wireRouteKey,
      classifyFailure: (error) =>
        error instanceof ModelError && error.scope === 'route'
          ? after(error)
          : undefined,
      isReachableFailure: modelScoped,
    },
  ];
}
