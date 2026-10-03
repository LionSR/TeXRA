/** The value helpers the sign-in flows share. */

/** The message of a thrown value. */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Coerce any thrown value to an Error instance. */
export function ensureError(err: unknown): Error {
  return err instanceof Error ? err : new Error(toErrorMessage(err));
}

/** A plain object (not `null`, not an array). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The log annotation key a host's sink reads a channel from; the key the
 * host's own channel annotation writes.
 */
export const LOG_CHANNEL = 'channel';
