/**
 * Best-effort write for CLI edges with no process runtime. A synchronous
 * throw from `write` (including `JSON.stringify` in the thunk) must mark
 * the stream closed and settle, not crash the process.
 */
export function bestEffortStreamWrite<T>(
  write: () => T,
  onSyncThrow: () => void,
): T | undefined {
  try {
    return write();
  } catch {
    onSyncThrow();
    return undefined;
  }
}
