import { Effect } from 'effect';
import {
  readChildTurnState,
  type ChildTurnKey,
} from '@agent/storage/runRecords';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { isInFlightPhase } from '@shared/runs/runStatus';
import type { RunId } from '@shared/schemas';
/**
 * Turn attribution for the executions tool's single latest-value slots.
 */

// Local imports

import { resolveRunLiveness, type RunLiveness } from './runLiveness';

/** How a turn is named in the note: its index within its attempt. */
const turnLabel = (turn: ChildTurnKey): string =>
  `turn ${turn.turnIndex} of attempt ${turn.attemptId}`;

/** How the accepted turn's fate reads, given what owns the run. */
function turnFate(turn: ChildTurnKey, liveness: RunLiveness): string {
  const label = turnLabel(turn);
  switch (liveness.kind) {
    case 'live':
      // A handle this process still tracks past its stream's terminal phase
      // is not a running turn: word it from the phase the registry reports,
      // the same way the process-output footer does.
      return isInFlightPhase(liveness.info.status)
        ? `${label} is still running`
        : `${label} ended with its run (${liveness.info.status})`;
    case 'unsettled':
      // Something alive owns the run elsewhere, or ownership could not be
      // read: either way nothing here may call the turn finished.
      return `${label} is ${liveness.reason}`;
    case 'interrupted':
    case 'settled':
      // No live owner anywhere and no result for this turn: the turn ended
      // with the process that was running it.
      return `${label} was interrupted before producing a result`;
  }
}

/**
 * One-line attribution note for /report and /result when a newer turn was
 * accepted but never persisted a result (#9531): without it, the single
 * latest-value slots would silently present the previous turn as current.
 *
 * Reads "still running" only while a handle this process tracks is still in
 * flight; a tracked handle whose stream already reached a terminal phase is
 * worded from that phase instead. A run another TeXRA process holds — or one
 * whose ownership cannot be read at all — renders that fact instead, because
 * this process cannot see how far such a turn got. A missing `meta.outcome` is
 * not liveness: a run whose owner crashed leaves exactly that, and it reads as
 * interrupted. Returns null when the slots reflect the latest accepted turn
 * (or the run has no turn identity at all).
 */
export const turnAttributionNote = Effect.fn('turnAttributionNote')(function* (
  runId: RunId,
  session: SessionHandle,
) {
  const { active, lastCompleted } = yield* readChildTurnState(session, runId);
  if (active === null) return null;
  const liveness = yield* resolveRunLiveness(runId, session);
  const fate = turnFate(active, liveness);
  const showing = lastCompleted
    ? `showing the latest completed turn (${turnLabel(lastCompleted)}).`
    : 'no turn has completed yet.';
  return `[Note: ${fate}; ${showing}]`;
});
