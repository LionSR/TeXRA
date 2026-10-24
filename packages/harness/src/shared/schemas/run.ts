import { Schema } from 'effect';

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

/** Runtime support declared by the launch source, independent of UI policy. */
export const USER_FOLLOW_UP_SUPPORT = {
  UNSUPPORTED: 'unsupported',
  NATIVE_INTERACTIVE: 'nativeInteractive',
  TERMINAL_BACKED: 'terminalBacked',
} as const;

export const UserFollowUpSupportSchema = Schema.Enum(USER_FOLLOW_UP_SUPPORT);
export type UserFollowUpSupport = typeof UserFollowUpSupportSchema.Type;

/**
 * The live phase vocabulary. Membership questions are answered by the
 * predicates `isActivePhase`, `isInFlightPhase` and
 * `isTerminalOutcomePhase`.
 */
export const RUN_PHASE = {
  RUNNING: 'running',
  WAITING: 'waiting',
  COMPLETED: RUN_OUTCOME.COMPLETED,
  CANCELLED: RUN_OUTCOME.CANCELLED,
  FAILED: RUN_OUTCOME.FAILED,
} as const;

export const RunPhaseSchema = Schema.Enum(RUN_PHASE);
export type RunPhase = typeof RunPhaseSchema.Type;

/**
 * Subset of `RunPhase` used for task groups (`TaskGroupSchema.status`,
 * populated from `GROUP_START`/`GROUP_END` transcript rows).
 * No `WAITING`: task groups have no waiting concept, only running and the
 * three terminal `RunOutcome` values. Using the native vocabulary keeps the
 * completed/cancelled distinction the group-end row records visible in the
 * rendered value.
 */
export const TaskGroupStatusSchema = Schema.Literals([
  RUN_PHASE.RUNNING,
  RUN_PHASE.COMPLETED,
  RUN_PHASE.CANCELLED,
  RUN_PHASE.FAILED,
]);
export type TaskGroupStatus = typeof TaskGroupStatusSchema.Type;

export const RUN_SUBSTATE = {
  STARTING: 'starting',
  RESUMING: 'resuming',
  /** Rested by a stop (`child.park` `paused`): not ended, continued by
   *  calling the child again. */
  PAUSED: 'paused',
  /** Parked holding a result its parent's input, open in another process,
   *  refused (`child.park` `delivery`): delivered when next admitted. */
  RESULT_WAITING: 'resultWaiting',
} as const;

export const RunSubstateSchema = Schema.Enum(RUN_SUBSTATE);
export type RunSubstate = typeof RunSubstateSchema.Type;

/** A child's park as its substate: a pause, a result held for its parent,
 *  else none. */
export function parkSubstate(park: {
  readonly phase: string;
  readonly heldFor?: string;
}): RunSubstate | null {
  if (park.phase === 'paused') return RUN_SUBSTATE.PAUSED;
  return park.heldFor === undefined ? null : RUN_SUBSTATE.RESULT_WAITING;
}

/** Substates of a child at rest that is not a lost run: it is not ended
 *  and nothing drives it, by design. */
export const RESTING_SUBSTATES: ReadonlySet<RunSubstate | null> = new Set([
  RUN_SUBSTATE.PAUSED,
  RUN_SUBSTATE.RESULT_WAITING,
]);

/**
 * Wire-level lifecycle status of a run with no lifecycle recorded yet. `as const`
 * is load-bearing: a bare `const` gives a *widening* literal type, which
 * widens back to `string` inside an object literal.
 */
export const RUN_LIFECYCLE_READY = 'ready' as const;

export type RunLifecycleStatus = RunPhase | typeof RUN_LIFECYCLE_READY;

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
export const RunActionSchema = Schema.Enum(RUN_ACTIONS);
export type RunAction = typeof RunActionSchema.Type;
