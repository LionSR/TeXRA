import { z } from 'zod';

import { AgentCategorySchema } from './agent';
import { ExecutionIdSchema, StreamTabIdSchema } from './identifiers';

/**
 * The retired 7-value live-status vocabulary. **Read-only residue** — no
 * production code decides anything from it any more (#7993 steps 2-3 moved
 * every live producer and host reader to `StreamPhase` + `StreamSubstate`).
 * It survives for exactly two reasons:
 *
 * 1. The standalone trace-viewer's file import (`replayTrace.ts`) parses
 *    externally-authored `trace.json` exports through
 *    `StreamLifecycleStatusSchema` and `StreamSnapshot.status` (§8.3's
 *    permanent boundary — a static exported file stays legacy-shaped
 *    forever).
 * 2. Display tolerance for that input
 *    (`@shared/streams/streamStatusDisplay`).
 *
 * The trait table that used to hang off this enum is gone: membership
 * questions are answered by the `StreamPhase` predicates in
 * `@shared/streams/streamStatus` (`isActivePhase`, `isInFlightPhase`,
 * `isTerminalOutcomePhase`). Do not add a new reader here — add a
 * `StreamPhase` one.
 */
export const STREAM_STATUS = {
  RUNNING: 'running',
  ERROR: 'error',
  STOPPED: 'stopped',
  READY: 'ready',
  WAITING: 'waiting',
  RESUMING: 'resuming',
  INITIALIZING: 'initializing',
} as const;

export const StreamStatusSchema = z.enum(STREAM_STATUS);
export type StreamStatus = z.infer<typeof StreamStatusSchema>;

export const EXECUTION_STATUS = {
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
  ERROR: 'error',
} as const;

export const ExecutionStatusSchema = z.enum(EXECUTION_STATUS);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

/**
 * Canonical terminal outcome of an agent run — the single fact "how did this
 * run end", decided exactly once at the run-lifecycle boundary. Current
 * production writers use these values for terminal run, group-end, and stream
 * state. `ExecutionStatus` remains an injective persisted-metadata projection.
 * Retired `EndGroupStatus` and `StreamStatus` values are accepted only by
 * parse-side compatibility readers and normalized to current values.
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

export const EXECUTION_STREAM_ID_SOURCE = {
  REGISTRATION: 'registration',
  LEGACY_RESOLUTION: 'legacyResolution',
} as const;
const ExecutionStreamIdSourceSchema = z.enum(EXECUTION_STREAM_ID_SOURCE);

/** Execution metadata stored alongside config at launch time. */
const ExecutionMetaBaseSchema = z.object({
  schemaVersion: z.literal(EXECUTION_META_SCHEMA_VERSION).prefault(1),
  timestamp: z.string(),
  parentExecutionId: ExecutionIdSchema.optional(),
  /** Persisted when execution reaches a terminal state (success or error). */
  terminalStatus: z.string().optional(),
  /** Canonical terminal outcome; legacy meta files derive this from terminalStatus. */
  outcome: RunOutcomeSchema.optional(),
  /** Runtime category override (e.g. 'process' for background bash). */
  category: z.string().optional(),
  /** AI-generated summary of what the session aimed to accomplish. */
  description: z.string().optional(),
  /**
   * The transcript stream this execution's data lives under. Current runs
   * write it at registration; it may be absent on historical executions.
   */
  streamId: StreamTabIdSchema.optional(),
  /** Distinguishes birth identity from a replaceable historical read cache. */
  streamIdSource: ExecutionStreamIdSourceSchema.optional(),
});

const ConsistentExecutionMetaSchema = ExecutionMetaBaseSchema.superRefine(
  (meta, ctx) => {
    if (meta.terminalStatus == null || meta.outcome == null) return;
    const projectedOutcome = executionStatusToRunOutcome(meta.terminalStatus);
    if (projectedOutcome == null || projectedOutcome === meta.outcome) return;

    ctx.addIssue({
      code: 'custom',
      path: ['outcome'],
      message: `outcome ${meta.outcome} contradicts terminalStatus ${meta.terminalStatus}`,
    });
  },
);

export const ExecutionMetaSchema = ConsistentExecutionMetaSchema.transform(
  (meta): z.infer<typeof ExecutionMetaBaseSchema> => {
    const outcome =
      meta.outcome ?? executionStatusToRunOutcome(meta.terminalStatus);
    return outcome ? { ...meta, outcome } : meta;
  },
);
export type ExecutionMeta = z.infer<typeof ExecutionMetaSchema>;

export const STREAM_PHASE = {
  RUNNING: STREAM_STATUS.RUNNING,
  WAITING: STREAM_STATUS.WAITING,
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
 * docs/proposals/2026-07-03-session-scoped-runtime-architecture.md). Using the
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

function isRunOutcome(value: string | undefined): value is RunOutcome {
  return RunOutcomeSchema.safeParse(value).success;
}

export function executionStatusToRunOutcome(
  status: string | undefined,
): RunOutcome | undefined {
  if (isRunOutcome(status)) return status;

  const parsed = ExecutionStatusSchema.safeParse(status);
  if (!parsed.success) return undefined;

  switch (parsed.data) {
    case EXECUTION_STATUS.COMPLETED:
      return RUN_OUTCOME.COMPLETED;
    case EXECUTION_STATUS.INTERRUPTED:
      return RUN_OUTCOME.CANCELLED;
    case EXECUTION_STATUS.ERROR:
      return RUN_OUTCOME.FAILED;
  }
}

function streamStatusToPhase(status: StreamStatus): StreamPhase {
  switch (status) {
    case STREAM_STATUS.RUNNING:
    case STREAM_STATUS.RESUMING:
    case STREAM_STATUS.INITIALIZING:
      return STREAM_PHASE.RUNNING;
    case STREAM_STATUS.WAITING:
      return STREAM_PHASE.WAITING;
    case STREAM_STATUS.ERROR:
      return STREAM_PHASE.FAILED;
    case STREAM_STATUS.STOPPED:
    case STREAM_STATUS.READY:
      return STREAM_PHASE.COMPLETED;
  }
}

export type StreamLifecycleStatus = StreamPhase | typeof STREAM_STATUS.READY;

export function streamStatusToLifecycleStatus(
  status: StreamStatus,
): StreamLifecycleStatus {
  return status === STREAM_STATUS.READY
    ? STREAM_STATUS.READY
    : streamStatusToPhase(status);
}

export const StreamLifecycleStatusSchema = z.union([
  StreamPhaseSchema,
  z.literal(STREAM_STATUS.READY),
  StreamStatusSchema.transform(streamStatusToLifecycleStatus),
]);

export const WORKTREE_PR_STATE = {
  OPEN: 'open',
  MERGED: 'merged',
  CLOSED: 'closed',
  DRAFT: 'draft',
} as const;

const WorktreePRStateSchema = z.enum(WORKTREE_PR_STATE);
export type WorktreePRState = z.infer<typeof WorktreePRStateSchema>;

export const WORKTREE_CI_STATE = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILURE: 'failure',
  UNKNOWN: 'unknown',
} as const;

const WorktreeCIStateSchema = z.enum(WORKTREE_CI_STATE);
export type WorktreeCIState = z.infer<typeof WorktreeCIStateSchema>;

const WorktreePRInfoSchema = z.object({
  number: z.number(),
  state: WorktreePRStateSchema,
  title: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  ciState: WorktreeCIStateSchema.optional(),
});

const WorktreeInfoSchema = z.object({
  /** Absolute path of the worktree the agent is operating in. */
  workingDirectory: z.string(),
  /** Current HEAD branch, if checked out. */
  branch: z.string().optional(),
  /** True if the working tree has uncommitted changes. */
  dirty: z.boolean().optional(),
  /** Associated GitHub pull request, if one is known to exist. */
  pr: WorktreePRInfoSchema.optional(),
});
export type WorktreeInfo = z.infer<typeof WorktreeInfoSchema>;

/**
 * Fields shared by every stream tab regardless of what's running underneath
 * it — split out rather than folded into the discriminated union below so
 * consumers can validate the common fields directly; Zod's discriminated
 * unions don't support `.pick()`/`.partial()`.
 */
const StreamTabInfoBaseSchema = z.object({
  name: z.string(),
  label: z.string(),
  /** Name of the agent/tool that launched the stream (e.g. "bash",
   * "paper-polish"). Present for both agent and process streams. */
  agent: z.string().optional(),
  agentCategory: AgentCategorySchema,
  isRemote: z.boolean().optional(),
  inputFile: z.string().optional(),
  creationTimestamp: z.number(),
  executionId: ExecutionIdSchema.optional(),
  parentStreamId: StreamTabIdSchema.optional(),
  /** AI-generated summary of what this session aims to accomplish. */
  description: z.string().optional(),
  /** Git worktree / PR context for streams whose agents operate in a
   * worktree other than the workspace root. Surfaced as a chip on the tab. */
  worktree: WorktreeInfoSchema.optional(),
});

/**
 * Discriminated on `kind`: a stream tab is a live LLM-driven `agent`, a raw
 * OS `process`, or a deterministic `workflowScript` orchestration container.
 * Only agents carry model metadata; only processes carry commands; workflow
 * scripts carry their immutable script name. Renderers switch on `kind`
 * instead of inferring ownership from whichever optional field is present.
 */
export const StreamTabInfoSchema = z.discriminatedUnion('kind', [
  StreamTabInfoBaseSchema.extend({
    kind: z.literal('agent'),
    model: z.string().optional(),
    modelLabel: z.string().optional(),
  }),
  StreamTabInfoBaseSchema.extend({
    kind: z.literal('process'),
    /** Full, untruncated command that spawned this stream; used by the
     * process stream view. */
    command: z.string().optional(),
  }),
  StreamTabInfoBaseSchema.extend({
    kind: z.literal('workflowScript'),
    /** Immutable `meta.name` of the orchestration script. */
    workflowName: z.string(),
  }),
]);
export type StreamTabInfo = z.infer<typeof StreamTabInfoSchema>;
