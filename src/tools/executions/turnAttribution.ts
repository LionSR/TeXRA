/**
 * Turn attribution for the executions tool's single latest-value slots.
 */

// Local imports
import type { ExecutionKVStore } from '@agent/storage';

import {
  resolveExecutionLiveness,
  type ExecutionLiveness,
} from './executionLiveness';

/** How the accepted turn's fate reads, given what owns the run. */
function turnFate(token: string, liveness: ExecutionLiveness): string {
  switch (liveness.kind) {
    case 'live':
      return `turn ${token} is still running`;
    case 'unsettled':
      // Something alive owns the run elsewhere, or ownership could not be
      // read: either way nothing here may call the turn finished.
      return `turn ${token} is ${liveness.reason}`;
    case 'interrupted':
    case 'settled':
      // No live owner anywhere and no result for this turn: the turn ended
      // with the process that was running it.
      return `turn ${token} was interrupted before producing a result`;
  }
}

/**
 * One-line attribution note for /report and /result when a newer turn was
 * accepted but never persisted a result (#9531): without it, the single
 * latest-value slots would silently present the previous turn as current.
 *
 * Reads "still running" only while something alive is running the execution —
 * a handle in this process, or another TeXRA process holding its lease. A
 * missing `meta.outcome` is not liveness: a run whose owner crashed leaves
 * exactly that, and it reads as interrupted. Returns null when the slots
 * reflect the latest accepted turn (or the execution has no turn identity at
 * all).
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
  const liveness = await resolveExecutionLiveness(
    store.getExecutionId(),
    meta?.outcome,
  );
  const fate = turnFate(active.token, liveness);
  const showing = completed
    ? `showing the latest completed turn (${completed}).`
    : 'no turn has completed yet.';
  return `[Note: ${fate}; ${showing}]`;
}
