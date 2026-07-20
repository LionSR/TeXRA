/** Normalize a caught value for structured desktop logging. */
export function toLogData(error: unknown): unknown {
  return error instanceof Error ? error : { error };
}
