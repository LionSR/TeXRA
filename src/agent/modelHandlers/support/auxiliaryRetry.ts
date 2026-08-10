import pRetry from 'p-retry';

import {
  isProviderErrorAutoRetryable,
} from '@common/errors/sdkError/providerErrorFormat';

/**
 * Bounded retry count for auxiliary provider calls (token counting, uploads,
 * compaction summarization, helper-model completions). Generation requests
 * run with SDK retries disabled because the node loop owns them; auxiliary
 * calls execute outside that loop, so they keep the provider SDKs' ordinary
 * two attempts. Pass to per-request options or `withOptions`.
 */
export const AUXILIARY_MAX_RETRIES = 2;

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
    ...(signal ? { signal } : {}),
    shouldRetry: ({ error }) => isProviderErrorAutoRetryable(error),
  });
}
