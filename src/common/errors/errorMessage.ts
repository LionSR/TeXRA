import { isNonEmptyString } from '@utils/core';

/** Normalize any thrown value into a user-friendly error message string. */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** Coerce any thrown value to an Error instance. */
export function ensureError(err: unknown): Error {
  return err instanceof Error ? err : new Error(toErrorMessage(err));
}

/**
 * Extract error message from Error objects or strings.
 * Returns `undefined` if the value is neither an Error nor a non-empty string.
 *
 * Use this when you need optional extraction. For a guaranteed string, use
 * {@link toErrorMessage}.
 */
export function extractErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error && isNonEmptyString(err.message)) {
    return err.message.trim();
  }
  if (isNonEmptyString(err)) {
    return err.trim();
  }
  return undefined;
}
