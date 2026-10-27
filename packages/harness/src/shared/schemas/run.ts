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

/**
 * One of the {@link RUN_OUTCOME} values, as a run's end row and its task
 * group's end record it.
 */
export const RunOutcomeSchema = Schema.Enum(RUN_OUTCOME);
/** The decoded shape of {@link RunOutcomeSchema}. */
export type RunOutcome = typeof RunOutcomeSchema.Type;

/** Runtime support declared by the launch source, independent of UI policy. */
export const USER_FOLLOW_UP_SUPPORT = {
  UNSUPPORTED: 'unsupported',
  NATIVE_INTERACTIVE: 'nativeInteractive',
  TERMINAL_BACKED: 'terminalBacked',
} as const;

/**
 * One of the {@link USER_FOLLOW_UP_SUPPORT} values: whether a run takes the
 * user's follow-up messages. A conversation run launched by a person is
 * `nativeInteractive`; a detached child reached through a terminal is
 * `terminalBacked`; a recipe or a single-cycle run is `unsupported`. The
 * `run.start` row records it and the session view shows it per run.
 */
export const UserFollowUpSupportSchema = Schema.Enum(USER_FOLLOW_UP_SUPPORT);
/** The decoded shape of {@link UserFollowUpSupportSchema}. */
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

/**
 * One of the {@link RUN_PHASE} values: a run's live status as the session view
 * holds it, running or waiting on a person, or ended with its outcome.
 */
export const RunPhaseSchema = Schema.Enum(RUN_PHASE);
/** The decoded shape of {@link RunPhaseSchema}. */
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
/** The decoded shape of {@link TaskGroupStatusSchema}. */
export type TaskGroupStatus = typeof TaskGroupStatusSchema.Type;

/**
 * A finer state shown beside a run's phase: a run that was just activated is
 * `starting` on its first activation and `resuming` on a later one until its
 * first `run.position` row clears it; a child at rest is `paused` or holding a
 * result for its parent.
 */
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

/**
 * One of the {@link RUN_SUBSTATE} values, as the session view carries it per
 * run.
 */
export const RunSubstateSchema = Schema.Enum(RUN_SUBSTATE);
/** The decoded shape of {@link RunSubstateSchema}. */
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

/**
 * A run's status as a host reads it: a {@link RunPhase}, or `ready` for a run
 * whose lifecycle has not started. The phase predicates in
 * `shared/runs/runStatus.ts` branch on it.
 */
export type RunLifecycleStatus = RunPhase | typeof RUN_LIFECYCLE_READY;

/**
 * The git worktree a run was launched into, when it was given one: the
 * `run.start` row records it and the session view shows it, so a host can open
 * the run's files where it actually wrote them.
 */
export const WorktreeInfoSchema = Schema.Struct({
  /** Absolute path of the worktree the agent is operating in. */
  workingDirectory: Schema.String,
});
/** The decoded shape of {@link WorktreeInfoSchema}. */
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
/**
 * One of the actions a host can offer on a run; see the list above for what
 * each does.
 */
export const RunActionSchema = Schema.Literals(RUN_ACTIONS);
/** The decoded shape of {@link RunActionSchema}. */
export type RunAction = typeof RunActionSchema.Type;
