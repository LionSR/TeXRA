import { getReasonPhrase } from 'http-status-codes';
import { Result, String as Str } from 'effect';
import { ModelError, PLAN_ROUTES, providerDisplayName } from '@texra-ai/llm';

import type {
  CredentialSwitch,
  DeclinableUsageRoute,
  ErrorContext,
  ErrorLogData,
  ProviderError,
  ProviderErrorClassification,
} from '@shared/schemas';
import {
  extractErrorMessage,
  toErrorMessage,
} from '@utils/errors/errorMessage';
import { formatCompactDuration } from '@utils/text/stringUtils';

import { AgentError, RouteUnavailable } from '../agentErrors';
import { findInCauseChain, isDiskFullError } from '../errorPredicates';

/** A used-up plan as the failure records it. */
type UsedUpPlan = Extract<
  ProviderErrorClassification,
  { readonly kind: DeclinableUsageRoute }
>;

/** An HTTP status's reason phrase; undefined for an unknown code (`getReasonPhrase` throws). */
function safeGetReasonPhrase(statusCode: number): string | undefined {
  return Result.getOrUndefined(Result.try(() => getReasonPhrase(statusCode)));
}

/**
 * The user-facing text of a failure: `HTTP {code}[ {text}] – {message}`
 * under a status, the message alone without one. Pure display formatting.
 */
function httpErrorMessage(
  statusCode: number | undefined,
  message: string,
  statusText = statusCode === undefined
    ? undefined
    : safeGetReasonPhrase(statusCode),
): string {
  return statusCode
    ? `HTTP ${statusCode}${statusText ? ` ${statusText}` : ''} – ${message}`
    : message;
}

/** The plan a quota verdict says ran out, with the tier and reset the
 *  provider stated; none for the account's own credit. */
function usedUpPlan({ quota }: ModelError): UsedUpPlan | undefined {
  if (quota === undefined || quota.plan === null) return undefined;
  return {
    kind: quota.plan,
    ...(quota.planType ? { planType: quota.planType } : {}),
    ...(quota.resetsInMs === undefined ? {} : { resetsInMs: quota.resetsInMs }),
  };
}

/** A failure's classification: an overflowed window, a used-up credential,
 *  a missing key, or a subscription session that could not bill. */
function classificationOf(
  error: ModelError | RouteUnavailable,
): ProviderErrorClassification | undefined {
  if (!(error instanceof ModelError)) {
    if (error.session !== undefined)
      return {
        kind: 'subscription-session',
        ...error.session,
        sessionError: error.message,
      };
    return error.missingApiKey === true
      ? { kind: 'missing-api-key' }
      : undefined;
  }
  if (error.kind === 'context-overflow') return { kind: 'context-window' };
  if (error.quota?.plan === null) return { kind: 'upstream-credit' };
  return usedUpPlan(error);
}

/**
 * The provider a plan bills, by its own name (`OpenAI` for a ChatGPT plan):
 * how the plain words below name a plan, so an embedder without copy of its
 * own reads what ran out. An app's switch and sign-in labels are its copy,
 * worded from the same facts where it shows them.
 */
const planOwner = (plan: DeclinableUsageRoute): string =>
  providerDisplayName(PLAN_ROUTES[plan].provider);

/** A used-up plan: which, its tier, when it resets, and what to do. */
function usedUpPlanMessage({ kind, planType, resetsInMs }: UsedUpPlan): string {
  const tier = planType ? ` ${Str.capitalize(planType)}` : '';
  const reset =
    resetsInMs === undefined
      ? ''
      : ` Resets in ${formatCompactDuration(resetsInMs)}.`;
  return (
    `Usage limit reached on your ${planOwner(kind)}${tier} plan.${reset}` +
    ' Switch to your own API key to keep working, or wait until the limit resets.'
  );
}

/** The words of a route that cannot carry the call: a subscription's own
 *  failure with its remedy, else the route's message. */
function routeMessage({ message, session }: RouteUnavailable): string {
  if (session === undefined) return message;
  const remedy = session.needsReauth
    ? 'Sign in again'
    : 'Try again in a moment';
  return `Your ${planOwner(session.route)} subscription is unavailable: ${message} ${remedy}, or turn the subscription off.`;
}

/**
 * The notice of a used-up plan's automatic retry on the model's own key,
 * the move its retry request records; the run records the route beside the
 * notice for an app's words.
 */
export function quotaFallbackMessage({
  route,
  provider,
}: Extract<CredentialSwitch, { readonly kind: 'decline-route' }>): string {
  return `Usage limit reached on your ${planOwner(route)} plan; retrying on your own ${providerDisplayName(provider)} API key.`;
}

/**
 * The words of a vendor failure. A used-up plan says what ran out and what
 * to do; an overflowed window says why a retry cannot help; anything else
 * is the reply's message under its status.
 */
function failureMessage(error: ModelError): string {
  const plan = usedUpPlan(error);
  if (plan !== undefined) return usedUpPlanMessage(plan);
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
 * A model call's failure as the person reads it, worded once for the retry a
 * run records (`failureInfo`) and for a failure formatted fresh: a helper
 * call, which records nothing, or a run that ended before recording one.
 */
export function providerErrorOf(
  error: ModelError | RouteUnavailable,
): ProviderError {
  const vendor = error instanceof ModelError ? error : undefined;
  const status = vendor?.status;
  const statusText =
    status === undefined ? undefined : safeGetReasonPhrase(status);
  const classification = classificationOf(error);
  return {
    message:
      error instanceof ModelError ? failureMessage(error) : routeMessage(error),
    ...(status !== undefined && { statusCode: status }),
    ...(statusText !== undefined && { statusText }),
    ...(classification !== undefined && { classification }),
    ...(vendor?.requestId !== undefined && { requestId: vendor.requestId }),
    ...(vendor?.cause !== undefined && { rawErrorBody: vendor.cause }),
  };
}

/** The words of a full disk, wherever one is met. */
const DISK_FULL_MESSAGE =
  'No space left on device. Free up disk space and try again.';

/** What a failure is, decided once for every reader: a full disk (an
 *  errno), the model failure in the cause chain (as the run that ended on it
 *  recorded it, else llm's verdict or the missing route worded fresh), or
 *  anything else in its own words. */
export function failureIn(
  err: unknown,
):
  | { readonly kind: 'disk-full'; readonly message: string }
  | { readonly kind: 'model'; readonly failure: ProviderError }
  | { readonly kind: 'unexpected'; readonly message: string } {
  if (isDiskFullError(err))
    return { kind: 'disk-full', message: DISK_FULL_MESSAGE };
  const failure = findInCauseChain(err, (cause) => {
    if (cause instanceof AgentError) return cause.failure;
    return cause instanceof ModelError || cause instanceof RouteUnavailable
      ? providerErrorOf(cause)
      : undefined;
  });
  return failure === undefined
    ? {
        kind: 'unexpected',
        message: extractErrorMessage(err) ?? 'Provider request failed',
      }
    : { kind: 'model', failure };
}

/** A failure as a host reads it: a full disk, a model failure, or the error's words. */
export function normalizeProviderError(err: unknown): ProviderError {
  const failure = failureIn(err);
  return failure.kind === 'model'
    ? failure.failure
    : { message: failure.message };
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
