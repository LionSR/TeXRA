/** Normalize any thrown value into a user-friendly error message string. */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
