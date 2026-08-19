/**
 * Turn attribution for the executions tool's single latest-value slots.
 */

// Local imports
import type { ExecutionKVStore } from '@agent/storage';

/**
 * One-line attribution note for /report and /result when a newer turn was
 * accepted but never persisted a result (#9531): without it, the single
 * latest-value slots would silently present the previous turn as current.
 * Reads "still running" while the execution is live and "was interrupted"
 * once it has terminalized. Returns null when the slots reflect the latest
 * accepted turn (or the execution has no turn identity at all).
 */
export async function turnAttributionNote(
  store: ExecutionKVStore,
): Promise<string | null> {
  const [turnState, meta] = await Promise.all([
    store.readTurnState(),
    store.readMeta(),
  ]);
  const active = turnState?.activeTurn;
  const completed = turnState?.lastCompletedTurn?.token;
  if (!active || active.token === completed) {
    return null;
  }
  const fate =
    meta?.outcome === undefined
      ? `turn ${active.token} is still running`
      : `turn ${active.token} was interrupted before producing a result`;
  const showing = completed
    ? `showing the latest completed turn (${completed}).`
    : 'no turn has completed yet.';
  return `[Note: ${fate}; ${showing}]`;
}
