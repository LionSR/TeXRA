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
