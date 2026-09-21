import { Effect } from 'effect';
import isNetworkError from 'is-network-error';

import { toErrorMessage } from '@utils/errors/errorMessage';

export function isCliFetchStackLog(args: readonly unknown[]): boolean {
  const [first] = args;
  if (!(first instanceof Error)) return false;
  const cause = first.cause;
  const causeMessage = cause instanceof Error ? toErrorMessage(cause) : '';
  return (
    isNetworkError(first) &&
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|getaddrinfo|remote\.texra\.ai/i.test(
      causeMessage,
    )
  );
}

/**
 * Run `program` with the model-access fetch's own stack dumps filtered out of
 * `console.error`. The swap is acquired and released around the program, so
 * an interrupted or failed run restores the sink exactly as a settled one
 * does.
 */
export function suppressCliFetchStackLogs<A, E, R>(
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        if (isCliFetchStackLog(args)) return;
        originalError(...args);
      };
      return originalError;
    }),
    () => program,
    (originalError) =>
      Effect.sync(() => {
        console.error = originalError;
      }),
  );
}

export function formatCliModelListError(error: unknown): string {
  const message = toErrorMessage(error);
  const detail =
    error instanceof Error && error.cause instanceof Error
      ? toErrorMessage(error.cause)
      : message;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed/i.test(detail)) {
    return `texra: could not fetch model access metadata from remote.texra.ai: ${detail}`;
  }
  return `texra: could not list models: ${message}`;
}
