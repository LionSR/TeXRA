import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { withLogChannel } from '@logger/effectLog';
import {
  HISTORY_RUN_STATUS,
  RUN_OUTCOME,
  type HistoryRunStatus,
  type RunId,
  type RunLifecycleStatus,
} from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';

const CHANNEL = 'CliToolUseResumeData';

/** What a run's history standing is decided from: the view's folded facts
 *  and `deriveResumability`'s answer. */
export interface CliRunFacts {
  readonly resumable: boolean;
  /** The run's folded status; a terminal outcome phase is its durable
   *  outcome, anything else means no outcome has landed. */
  readonly phase?: RunLifecycleStatus;
  /** A stop rested the run instead of ending it (a paused child). */
  readonly paused?: boolean;
  /** A row of the run this build cannot read: it is never resumed here. */
  readonly blocked?: boolean;
}

/** A run's CLI history standing: the frozen `status` and the `resumable`
 *  boolean beside it. */
export interface CliRunStanding {
  readonly status: HistoryRunStatus;
  readonly resumable: boolean;
}

/**
 * The history standing of a run. `status` is a frozen contract (texra-action
 * reads the NDJSON stream): resumability promotes only an interrupted or
 * outcome-less run to `resumable`, so a failed run that can continue still
 * reports `failed` beside `resumable: true`. An outcome-less run that cannot
 * continue reports `unknown`.
 */
export function cliRunStanding(facts: CliRunFacts): CliRunStanding {
  // A paused child is continued by its parent's model, never by `resume`.
  if (facts.paused)
    return { status: HISTORY_RUN_STATUS.PAUSED, resumable: false };
  if (facts.blocked)
    return { status: HISTORY_RUN_STATUS.BLOCKED, resumable: false };
  const outcome = isTerminalOutcomePhase(facts.phase) ? facts.phase : undefined;
  const status =
    facts.resumable &&
    (outcome === undefined || outcome === RUN_OUTCOME.CANCELLED)
      ? HISTORY_RUN_STATUS.RESUMABLE
      : (outcome ?? HISTORY_RUN_STATUS.UNKNOWN);
  return { status, resumable: facts.resumable };
}

/**
 * Whether a workflow checkpoint only replays a terminal compile rejection:
 * the last round's compile was rejected and no round is left to fix it. The
 * rows carry no such marker: the loop concluded (`halted`, its last round
 * closed) with no model failure, and its own `halted` position says FAILED,
 * which only the rejection leaves (output finalization's verdict is
 * `run.end`'s, not the loop's). Rows that cannot be read or folded leave the
 * run offered, and refused at open time like any unreadable run.
 */
export const isTerminalWorkflowCheckpoint = Effect.fn(
  'isTerminalWorkflowCheckpoint',
)(function* (id: RunId, session: SessionHandle): Effect.fn.Return<boolean> {
  const state = yield* session.runHistory
    .load(id)
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `Advertising workflow ${id} as resumable without its loop verdict: ${error.message}`,
        ).pipe(withLogChannel(CHANNEL), Effect.as(null)),
      ),
    );
  return (
    state !== null &&
    state.phase === 'halted' &&
    state.lastError === null &&
    state.outcome === RUN_OUTCOME.FAILED
  );
});
