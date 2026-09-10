import { z } from 'zod';

import { RunIdSchema } from './identifiers';
import { RunIdentitySchema } from './runIdentity';
import { WorkflowRunSnapshotSchema } from './workflowRunSnapshot';

export const CLI_RUN_STATUS = {
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
  ERROR: 'error',
} as const;

export type CliRunStatus =
  (typeof CLI_RUN_STATUS)[keyof typeof CLI_RUN_STATUS];

/**
 * Canonical terminal outcome of an agent run — the single fact "how did this
 * run end", decided exactly once at the run-lifecycle boundary. Current
 * production writers use these values for terminal run, group-end, and stream
 * state. `CliRunStatus` remains an injective persisted-metadata projection.
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

export const RUN_META_SCHEMA_VERSION = 1;

/** Runtime support declared by the launch source, independent of UI policy. */
export const USER_FOLLOW_UP_SUPPORT = {
  UNSUPPORTED: 'unsupported',
  NATIVE_INTERACTIVE: 'nativeInteractive',
  TERMINAL_BACKED: 'terminalBacked',
} as const;

export const UserFollowUpSupportSchema = z.enum(USER_FOLLOW_UP_SUPPORT);
export type UserFollowUpSupport = z.infer<typeof UserFollowUpSupportSchema>;

/** Core run metadata that remains readable without workflow observability. */
const RunMetaCoreSchema = z.object({
  schemaVersion: z.literal(RUN_META_SCHEMA_VERSION).prefault(1),
  timestamp: z.string(),
  /** The launching run, from `run.start.parent`; absent for a root or a detached child. */
  parentRunId: RunIdSchema.optional(),
  /** Canonical terminal outcome — the ONE persisted terminal fact. */
  outcome: RunOutcomeSchema.optional(),
  /** What kind of run this run is. Registration declares it at birth. */
  identity: RunIdentitySchema,
  /** Runtime behavior declared by the run source, not UI visibility. */
  userFollowUpSupport: UserFollowUpSupportSchema.optional(),
  /** AI-generated summary of what the session aimed to accomplish. */
  description: z.string().optional(),
});

/** Run metadata stored alongside config at launch time. */
export const RunMetaSchema = RunMetaCoreSchema.extend({
  /** Canonical run state for a detached workflow run. */
  workflow: WorkflowRunSnapshotSchema.optional(),
});

export type RunMeta = z.infer<typeof RunMetaSchema>;

/**
 * The live phase vocabulary. Membership questions are answered by the
 * predicates in `@shared/runs/runStatus` (`isActivePhase`,
 * `isInFlightPhase`, `isTerminalOutcomePhase`).
 */
export const RUN_PHASE = {
  RUNNING: 'running',
  WAITING: 'waiting',
  COMPLETED: RUN_OUTCOME.COMPLETED,
  CANCELLED: RUN_OUTCOME.CANCELLED,
  FAILED: RUN_OUTCOME.FAILED,
} as const;

export const RunPhaseSchema = z.enum(RUN_PHASE);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

/**
 * Subset of `RunPhase` used for task groups (`TaskGroupSchema.status`,
 * populated from `GROUP_START`/`GROUP_END` transcript rows — #7993 step 3).
 * No `WAITING`: task groups have no waiting concept, only running and the
 * three terminal `RunOutcome` values (§8.2's group-end mapping table,
 * .agents/docs/archived/architecture/2026-07-03-session-scoped-runtime-architecture.md). Using the
 * native vocabulary keeps the completed/cancelled distinction §8.2 writes to
 * the transcript row visible in the rendered value.
 */
export const TaskGroupStatusSchema = z.enum([
  RUN_PHASE.RUNNING,
  RUN_PHASE.COMPLETED,
  RUN_PHASE.CANCELLED,
  RUN_PHASE.FAILED,
]);
export type TaskGroupStatus = z.infer<typeof TaskGroupStatusSchema>;

export const RUN_SUBSTATE = {
  STARTING: 'starting',
  RESUMING: 'resuming',
} as const;

export const RunSubstateSchema = z.enum(RUN_SUBSTATE);
export type RunSubstate = z.infer<typeof RunSubstateSchema>;

/**
 * Wire-level lifecycle status of a stream that has no phase in this process:
 * its run lease is held by another TeXRA process, or its run state
 * could not be read at startup. Not a `RunPhase`: phases are facts about
 * runs live here. `RunView.statusDetail` carries the reason; renderers
 * show it read-only and Delete is the only run control that applies.
 */
export const RUN_LIFECYCLE_UNAVAILABLE = 'unavailable' as const;

/**
 * Wire-level lifecycle status of a stream with no run recorded yet. `as const`
 * is load-bearing: a bare `const` gives a *widening* literal type, which
 * widens back to `string` inside an object literal.
 */
export const RUN_LIFECYCLE_READY = 'ready' as const;

export type RunLifecycleStatus =
  | RunPhase
  | typeof RUN_LIFECYCLE_READY
  | typeof RUN_LIFECYCLE_UNAVAILABLE;

export const WorktreeInfoSchema = z.object({
  /** Absolute path of the worktree the agent is operating in. */
  workingDirectory: z.string(),
  /** Current HEAD branch, if checked out. */
  branch: z.string().optional(),
  /** True if the working tree has uncommitted changes. */
  dirty: z.boolean().optional(),
});
export type WorktreeInfo = z.infer<typeof WorktreeInfoSchema>;
