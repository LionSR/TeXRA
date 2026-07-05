/**
 * Cancellation helper for tool implementations whose underlying async
 * operation cannot be aborted (third-party clients with no AbortSignal
 * hook, shared throttle waits).
 */

import { ToolError } from '@shared/schemas/toolResult';

/**
 * Race an un-cancellable async operation against the owning tool call's
 * abort signal.
 *
 * On abort the in-flight operation is *abandoned*, not aborted: it settles
 * in the background and its result is discarded, while the caller gets an
 * immediate `ToolError` so a cancelled dispatch batch stops waiting.
 *
 * Only safe for idempotent, read-only operations (GET lookups, throttle
 * waits) — never abandon a write, since it may still complete after the
 * caller has reported cancellation.
 */
export async function abandonOnAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  what: string,
): Promise<T> {
  if (!signal) return operation;
  const cancelled = () => new ToolError(`Cancelled ${what}.`);
  if (signal.aborted) {
    // Abandoned operation: swallow its eventual rejection (if any) so the
    // orphaned promise never surfaces as an unhandled rejection.
    operation.catch(() => {});
    throw cancelled();
  }
  let removeListener = () => {};
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        const onAbort = () => reject(cancelled());
        signal.addEventListener('abort', onAbort, { once: true });
        removeListener = () => signal.removeEventListener('abort', onAbort);
      }),
    ]);
  } catch (error) {
    operation.catch(() => {});
    throw error;
  } finally {
    removeListener();
  }
}
