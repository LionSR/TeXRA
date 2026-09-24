import { Effect } from 'effect';
import { readChildTurnState } from '@agent/storage/runRecords';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import type { RunId } from '@shared/schemas';
import type { AttemptKey } from '@shared/session/attemptFold';
import type { RunView } from '@shared/session/sessionView';
/**
 * Turn attribution for the executions tool's single latest-value slots.
 */

/** How a turn is named in the note: its index within its attempt. */
const turnLabel = (turn: AttemptKey): string =>
  `turn ${turn.index} of attempt ${turn.key}`;

/** How the accepted turn's fate reads, from the run's row in the session
 *  fold, which has already decided ownership for every run. */
function turnFate(turn: AttemptKey, run: RunView | undefined): string {
  const label = turnLabel(turn);
  // No live owner anywhere and no result for this turn: the turn ended with
  // the process that was running it. A run gone from the view (deleted) has
  // nothing left to say otherwise.
  if (run === undefined || run.group === 'interrupted') {
    return `${label} was interrupted before producing a result`;
  }
  if (isTerminalOutcomePhase(run.status)) {
    return `${label} was interrupted: it ended with its run (${run.status}) before producing a result`;
  }
  // Another TeXRA process holds the run, or its state cannot be read here:
  // either way nothing here may call the turn finished.
  if (run.statusDetail !== null) {
    return `${label} has not finished: ${run.statusDetail}`;
  }
  return `${label} is still running`;
}

/**
 * One-line attribution note for /report and /result when a newer turn was
 * accepted but never persisted a result (#9531): without it, the single
 * latest-value slots would silently present the previous turn as current.
 *
 * Reads the run's row in the session fold, the same reading the process
 * output footer states: "still running" only while its owner is alive and
 * the run is in flight; a terminal run words the turn from its outcome; a run
 * another TeXRA process holds, or one whose state cannot be read, renders that
 * fact, because this process cannot see how far such a turn got. A missing
 * outcome is not liveness: a run whose owner crashed leaves exactly that, and
 * it reads as
 * interrupted. Returns null when the slots reflect the latest accepted turn
 * (or the run has no turn identity at all).
 */
export const turnAttributionNote = Effect.fn('turnAttributionNote')(function* (
  runId: RunId,
  session: SessionHandle,
) {
  const { active, lastCompleted } = yield* readChildTurnState(session, runId);
  if (active === null) return null;
  const fate = turnFate(active, session.runView(runId));
  const showing = lastCompleted
    ? `showing the latest completed turn (${turnLabel(lastCompleted)}).`
    : 'no turn has completed yet.';
  return `[Note: ${fate}; ${showing}]`;
});
