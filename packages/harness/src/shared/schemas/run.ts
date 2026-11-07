import { Cause, Schema } from 'effect';

/**
 * Canonical terminal outcome of an agent run — the single fact "how did this
 * run end", decided exactly once at the run-lifecycle boundary. Current
 * production writers use these values for terminal run, group-end, and run
 * state.
 *
 * `cancelled` is a sibling of `failed`, never folded into it — a user stop is
 * not an error. This is the triad `ResultEvent.outcome` carries.
 */
export const RUN_OUTCOME = {
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
} as const;

export const RunOutcomeSchema = Schema.Enum(RUN_OUTCOME);
export type RunOutcome = typeof RunOutcomeSchema.Type;

/**
 * The one verdict of how a run that did not return ended, from its failure
 * cause: a stop outranks a failure, and any interrupt in the cause is a
 * stop, even when a finalizer then failed (`Interrupt` + `Die`), so every
 * terminal row agrees.
 */
export function outcomeFromCause(cause: Cause.Cause<unknown>): RunOutcome {
  return Cause.hasInterrupts(cause)
    ? RUN_OUTCOME.CANCELLED
    : RUN_OUTCOME.FAILED;
}

/**
 * Where a run's loop stands: `ready` takes an activation (none yet, or its
 * last one ended), `running` is inside a turn, `waiting` between turns. How
 * it ended is the separate `RunOutcome`.
 */
export const RunPositionSchema = Schema.Literals([
  'ready',
  'running',
  'waiting',
]);
export type RunPosition = typeof RunPositionSchema.Type;

/**
 * A stage's status (`StageSchema.status`, from `stage.start` and
 * `stage.end` rows, and the run's end for a group still open): running, or
 * the outcome it closed with.
 */
export const StageStatusSchema = Schema.Union([
  Schema.Literal('running'),
  RunOutcomeSchema,
]);
export type StageStatus = typeof StageStatusSchema.Type;

export const WorktreeInfoSchema = Schema.Struct({
  /** Absolute path of the worktree the agent is operating in. */
  workingDirectory: Schema.String,
});
export type WorktreeInfo = typeof WorktreeInfoSchema.Type;

/**
 * The actions a host can offer on a run. The fold computes each run's set
 * from its state ({@link runActions}); every host renders from that set and
 * every handler refuses an action the set no longer holds.
 */
const RUN_ACTIONS = [
  /** Stop a live run. */
  'stop',
  /** Grant the run an approval bypass while it works (a live agent's run). */
  'grant',
  /** Compact a live conversation (not a task's recipe). */
  'compact',
  /** Continue the run where it stopped. */
  'resume',
  /** Open the launch form on the run's saved setup, to change and start. */
  'runAgain',
  /** A new task holding this conversation (`run.fork`). */
  'fork',
  /** A settled run's files: read, copied, or removed (`run.files`). */
  'files',
  /** Remove the run and its folder from history. */
  'delete',
  /** Give the run the user's own title. */
  'rename',
  /** Read-only: open its folder, export its conversation, copy its diagnostics. */
  'openRunStorage',
  'export',
  'copy',
] as const;
export const RunActionSchema = Schema.Literals(RUN_ACTIONS);
export type RunAction = typeof RunActionSchema.Type;
