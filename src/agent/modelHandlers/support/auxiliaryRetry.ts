import pRetry from 'p-retry';

import { isProviderErrorAutoRetryable } from '@common/errors/sdkError/providerErrorFormat';

/**
 * Bounded retry count for auxiliary provider calls (token counting, uploads,
 * compaction summarization, helper-model completions). Generation requests
 * run with SDK retries disabled because the node loop owns them; auxiliary
 * calls execute outside that loop, so they keep the provider SDKs' ordinary
 * two attempts. Pass to per-request options or `withOptions`.
 */
export const AUXILIARY_MAX_RETRIES = 2;

/**
 * SDK-level retries for provider clients, disabled. The run's `ModelInvoker`
 * is the single retry owner for generation requests (an automatic batch,
 * then one approved manual attempt at a time), so a provider SDK retrying
 * underneath it would spend attempts against a budget the invoker cannot
 * see. Client constructors default to this value and the auxiliary
 * calls listed on {@link AUXILIARY_MAX_RETRIES} opt back up per request.
 *
 * The OpenRouter SDK expresses the same decision as
 * `retryConfig: { strategy: 'none' }` rather than a count, so its client in
 * `modelHandlerOpenRouterNative.getClient` states the policy in its own terms
 * instead of importing this constant.
 */
export const SDK_RETRIES_DISABLED = 0;

/** Run an auxiliary provider call under the shared bounded-retry policy. */
export function auxiliaryRetry<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return pRetry(operation, {
    retries: AUXILIARY_MAX_RETRIES,
    minTimeout: 500,
    factor: 2,
    randomize: true,
    signal,
    shouldRetry: ({ error }) => isProviderErrorAutoRetryable(error),
  });
}
