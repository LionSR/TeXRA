import { z } from 'zod';

import { AgentCategorySchema } from './agent';
import { ExecutionIdSchema, StreamTabIdSchema } from './identifiers';
import { RunIdentitySchema } from './runIdentity';
import { WorkflowExecutionSnapshotSchema } from './workflowExecutionSnapshot';

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
  parentExecutionId: ExecutionIdSchema.optional(),
  /** Canonical terminal outcome — the ONE persisted terminal fact. */
  outcome: RunOutcomeSchema.optional(),
  /**
   * What kind of run this execution is. Registration declares it at birth;
   * optional here because this schema is
   * transitively the trace-export schema (immutable pre-migration exports).
   * A row without one lists as `incomplete`.
   */
  identity: RunIdentitySchema.optional(),
  /** Runtime behavior declared by the execution source, not UI visibility. */
  userFollowUpSupport: UserFollowUpSupportSchema.optional(),
  /** AI-generated summary of what the session aimed to accomplish. */
  description: z.string().optional(),
  /**
   * The transcript stream this execution's data lives under — the ONE
   * execution→stream mapping, written at registration. A row without one has
   * no persisted stream; nothing re-derives it from names or scans.
   */
  streamId: StreamTabIdSchema.optional(),
});

/** Execution metadata stored alongside config at launch time. */
export const ExecutionMetaSchema = ExecutionMetaCoreSchema.extend({
  /** Canonical execution state for a detached workflow run. */
  workflow: WorkflowExecutionSnapshotSchema.optional(),
});

export type ExecutionMeta = z.infer<typeof ExecutionMetaSchema>;

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

export const StreamPhaseSchema = z.enum(STREAM_PHASE);
export type StreamPhase = z.infer<typeof StreamPhaseSchema>;

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

export const StreamSubstateSchema = z.enum(STREAM_SUBSTATE);
export type StreamSubstate = z.infer<typeof StreamSubstateSchema>;

/**
 * Wire-level lifecycle status of a stream that has no phase in this process:
 * its execution lease is held by another TeXRA process, or its run state
 * could not be read at startup. Not a `StreamPhase`: phases are facts about
 * runs live here. `StreamMetadata.statusDetail` carries the reason; renderers
 * show it read-only and Delete is the only run control that applies.
 */
export const STREAM_LIFECYCLE_UNAVAILABLE = 'unavailable' as const;

/**
 * Wire-level lifecycle status of a stream with no run recorded yet. `as const`
 * is load-bearing: a bare `const` gives a *widening* literal type, which
 * widens back to `string` inside an object literal.
 */
export const STREAM_LIFECYCLE_READY = 'ready' as const;

export type StreamLifecycleStatus =
  | StreamPhase
  | typeof STREAM_LIFECYCLE_READY
  | typeof STREAM_LIFECYCLE_UNAVAILABLE;

export const StreamLifecycleStatusSchema = z.union([
  StreamPhaseSchema,
  z.literal(STREAM_LIFECYCLE_READY),
  z.literal(STREAM_LIFECYCLE_UNAVAILABLE),
]);

export const WorktreeInfoSchema = z.object({
  /** Absolute path of the worktree the agent is operating in. */
  workingDirectory: z.string(),
  /** Current HEAD branch, if checked out. */
  branch: z.string().optional(),
  /** True if the working tree has uncommitted changes. */
  dirty: z.boolean().optional(),
});
export type WorktreeInfo = z.infer<typeof WorktreeInfoSchema>;

/**
 * The identity and storage pointers carried by each stream tab.
 */
const StreamIdentityFieldsSchema = z.object({
  /** The run's identity, verbatim from `run.start` or the durable store. */
  identity: RunIdentitySchema.optional(),
  /** Runtime behavior declared by the launch source, not UI visibility. */
  userFollowUpSupport: UserFollowUpSupportSchema.optional(),
  /** The agent's execution mode (agent runs only) — display/routing data
   * beside the identity, sourced from the run's config. */
  agentCategory: AgentCategorySchema.optional(),
  isRemote: z.boolean().optional(),
  creationTimestamp: z.number(),
  executionId: ExecutionIdSchema.optional(),
  parentStreamId: StreamTabIdSchema.optional(),
  /** AI-generated summary of what this session aims to accomplish. */
  description: z.string().optional(),
});
/**
 * One flat wire shape per stream tab. The parsed {@link RunIdentitySchema}
 * struct travels verbatim — renderers key on `identity.kind` instead of
 * inferring ownership from whichever optional field is present — and hosts
 * add display fields beside it, never re-encodings of it. `identity` is
 * absent only for a run that never emitted `run.start` (legacy meta, hosts
 * driving the store by hand); absent renders as pending, never as a default
 * kind.
 */
const StreamTabInfoSchema = StreamIdentityFieldsSchema.extend({
  name: z.string(),
  /**
   * Canonical display name. When `identity` is present, every producer must
   * set this to `runIdentityDisplayName(identity)`. Only identity-less legacy
   * or pending streams may use the stream-id-derived fallback.
   */
  label: z.string(),
  model: z.string().optional(),
  modelLabel: z.string().optional(),
  /** Full, untruncated command that spawned a process stream. */
  command: z.string().optional(),
  /** Git worktree / PR context for streams whose agents operate in a
   * worktree other than the workspace root. Surfaced as a chip on the tab. */
  worktree: WorktreeInfoSchema.optional(),
});
export type StreamTabInfo = z.infer<typeof StreamTabInfoSchema>;
