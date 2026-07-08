/** Normalize a caught error into a logger `data` argument, preserving Error instances as-is. */
export function toLogData(error: unknown): unknown {
  return error instanceof Error ? error : { error };
}
