import { z } from 'zod';

import { RunIdSchema, StreamTabIdSchema } from './identifiers';
import { RunIdentitySchema } from './runIdentity';
import { WorkflowRunSnapshotSchema } from './workflowExecutionSnapshot';

export const EXECUTION_STATUS = {
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
  ERROR: 'error',
} as const;

export type ExecutionStatus =
  (typeof EXECUTION_STATUS)[keyof typeof EXECUTION_STATUS];

/**
 * Canonical terminal outcome of an agent run — the single fact "how did this
 * run end", decided exactly once at the run-lifecycle boundary. Current
 * production writers use these values for terminal run, group-end, and stream
 * state. `ExecutionStatus` remains an injective persisted-metadata projection.
 *
 * `cancelled` is a sibling of `failed`, never folded into it — a user stop is
 * not an error. This is the triad `ResultEvent.outcome` carries.
 */
export const RUN_OUTCOME = {
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
} as const;

export const RunOutcomeSchema = z.enum(RUN_OUTCOME);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const EXECUTION_META_SCHEMA_VERSION = 1;

/** Runtime support declared by the launch source, independent of UI policy. */
export const USER_FOLLOW_UP_SUPPORT = {
  UNSUPPORTED: 'unsupported',
  NATIVE_INTERACTIVE: 'nativeInteractive',
  TERMINAL_BACKED: 'terminalBacked',
} as const;

export const UserFollowUpSupportSchema = z.enum(USER_FOLLOW_UP_SUPPORT);
export type UserFollowUpSupport = z.infer<typeof UserFollowUpSupportSchema>;

/** Core execution metadata that remains readable without workflow observability. */
const ExecutionMetaCoreSchema = z.object({
  schemaVersion: z.literal(EXECUTION_META_SCHEMA_VERSION).prefault(1),
  timestamp: z.string(),
  parentExecutionId: RunIdSchema.optional(),
  /** Canonical terminal outcome — the ONE persisted terminal fact. */
  outcome: RunOutcomeSchema.optional(),
  /** What kind of run this execution is. Registration declares it at birth. */
  identity: RunIdentitySchema,
  /** Runtime behavior declared by the execution source, not UI visibility. */
  userFollowUpSupport: UserFollowUpSupportSchema.optional(),
  /** AI-generated summary of what the session aimed to accomplish. */
  description: z.string().optional(),
  /**
   * The transcript stream this execution's data lives under — the ONE
   * execution→stream mapping, written at registration. A row without one has
   * no persisted stream; nothing re-derives it from names or scans.
   */
  streamId: StreamTabIdSchema,
});

/** Execution metadata stored alongside config at launch time. */
export const RunMetaSchema = ExecutionMetaCoreSchema.extend({
  /** Canonical execution state for a detached workflow run. */
  workflow: WorkflowRunSnapshotSchema.optional(),
});

export type RunMeta = z.infer<typeof RunMetaSchema>;

/**
 * The live phase vocabulary. Membership questions are answered by the
 * predicates in `@shared/streams/streamStatus` (`isActivePhase`,
 * `isInFlightPhase`, `isTerminalOutcomePhase`).
 */
export const STREAM_PHASE = {
  RUNNING: 'running',
  WAITING: 'waiting',
  COMPLETED: RUN_OUTCOME.COMPLETED,
  CANCELLED: RUN_OUTCOME.CANCELLED,
  FAILED: RUN_OUTCOME.FAILED,
} as const;

export const RunPhaseSchema = z.enum(STREAM_PHASE);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

/**
 * Subset of `StreamPhase` used for task groups (`TaskGroupSchema.status`,
 * populated from `GROUP_START`/`GROUP_END` transcript rows — #7993 step 3).
 * No `WAITING`: task groups have no waiting concept, only running and the
 * three terminal `RunOutcome` values (§8.2's group-end mapping table,
 * .agents/docs/archived/architecture/2026-07-03-session-scoped-runtime-architecture.md). Using the
 * native vocabulary keeps the completed/cancelled distinction §8.2 writes to
 * the transcript row visible in the rendered value.
 */
export const TaskGroupStatusSchema = z.enum([
  STREAM_PHASE.RUNNING,
  STREAM_PHASE.COMPLETED,
  STREAM_PHASE.CANCELLED,
  STREAM_PHASE.FAILED,
]);
export type TaskGroupStatus = z.infer<typeof TaskGroupStatusSchema>;

export const STREAM_SUBSTATE = {
  STARTING: 'starting',
  RESUMING: 'resuming',
} as const;

export const RunSubstateSchema = z.enum(STREAM_SUBSTATE);
export type RunSubstate = z.infer<typeof RunSubstateSchema>;

/**
 * Wire-level lifecycle status of a stream that has no phase in this process:
 * its execution lease is held by another TeXRA process, or its run state
 * could not be read at startup. Not a `StreamPhase`: phases are facts about
 * runs live here. `StreamView.statusDetail` carries the reason; renderers
 * show it read-only and Delete is the only run control that applies.
 */
export const STREAM_LIFECYCLE_UNAVAILABLE = 'unavailable' as const;

/**
 * Wire-level lifecycle status of a stream with no run recorded yet. `as const`
 * is load-bearing: a bare `const` gives a *widening* literal type, which
 * widens back to `string` inside an object literal.
 */
export const STREAM_LIFECYCLE_READY = 'ready' as const;

export type RunLifecycleStatus =
  | RunPhase
  | typeof STREAM_LIFECYCLE_READY
  | typeof STREAM_LIFECYCLE_UNAVAILABLE;

export const WorktreeInfoSchema = z.object({
  /** Absolute path of the worktree the agent is operating in. */
  workingDirectory: z.string(),
  /** Current HEAD branch, if checked out. */
  branch: z.string().optional(),
  /** True if the working tree has uncommitted changes. */
  dirty: z.boolean().optional(),
});
export type WorktreeInfo = z.infer<typeof WorktreeInfoSchema>;
