import { ModelError, providerDisplayName } from '@texra-ai/llm';

import {
  type CredentialSwitch,
  type ErrorContext,
  type ErrorLogData,
  type ModelFailure,
  modelFailureMessage,
  planOwner,
  type ProviderError,
} from '@shared/schemas';
import {
  extractErrorMessage,
  toErrorMessage,
} from '@utils/errors/errorMessage';

import { AgentError, RouteUnavailable } from '../agentErrors';
import { findInCauseChain, isDiskFullError } from '../errorPredicates';

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
 * A model call's failure as a run records it: llm's verdict on the vendor's
 * reply, or the route that could not carry the call, on a binding of
 * `provider` when the caller knows it.
 */
export function modelFailureOf(
  error: ModelError | RouteUnavailable,
  provider?: string,
): ModelFailure {
  const on = provider === undefined ? {} : { provider };
  if (error instanceof RouteUnavailable)
    return {
      source: 'route',
      ...on,
      message: error.message,
      ...(error.missingApiKey && { missingApiKey: true }),
      ...(error.session && { session: error.session }),
    };
  const { kind, message, status, requestId, quota, partialText } = error;
  return {
    source: 'model',
    ...on,
    kind,
    message,
    ...(status !== undefined && { status }),
    ...(requestId !== undefined && { requestId }),
    ...(quota !== undefined && { quota }),
    ...(partialText ? { partialText } : {}),
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
  | { readonly kind: 'model'; readonly failure: ModelFailure }
  | { readonly kind: 'unexpected'; readonly message: string } {
  if (isDiskFullError(err))
    return { kind: 'disk-full', message: DISK_FULL_MESSAGE };
  const failure = findInCauseChain(err, (cause) => {
    if (cause instanceof AgentError) return cause.failure;
    return cause instanceof ModelError || cause instanceof RouteUnavailable
      ? modelFailureOf(cause)
      : undefined;
  });
  return failure === undefined
    ? {
        kind: 'unexpected',
        message: extractErrorMessage(err) ?? 'Provider request failed',
      }
    : { kind: 'model', failure };
}

/** A failure as a host reads it: its plain words, with the model call's
 *  verdict and the vendor's raw body when a model call failed. */
export function normalizeProviderError(err: unknown): ProviderError {
  const found = failureIn(err);
  if (found.kind !== 'model') return { message: found.message };
  const vendor = findInCauseChain(err, (cause) =>
    cause instanceof ModelError ? cause : undefined,
  );
  return {
    message: modelFailureMessage(found.failure),
    failure: found.failure,
    ...(vendor?.cause !== undefined && { rawErrorBody: vendor.cause }),
  };
}

/** Builds consistent error data for logging with MESSAGE_TYPES.ERROR. */
export function buildErrorLogData(
  err: unknown,
  context?: ErrorContext,
): ErrorLogData {
  const found = failureIn(err);
  const where = {
    ...(context?.operation !== undefined && { operation: context.operation }),
    ...(context?.model !== undefined && { model: context.model }),
  };
  if (found.kind === 'model') return { failure: found.failure, ...where };
  const rawMessage = toErrorMessage(err);
  return {
    message: found.message,
    ...(rawMessage !== found.message && { rawMessage }),
    ...where,
  };
}
