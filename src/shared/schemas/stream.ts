import { z } from 'zod';

import { AgentCategorySchema } from './agent';
import { ExecutionIdSchema, StreamTabIdSchema } from './identifiers';

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

/**
 * Declarative trait table for the live stream state machine — the single
 * source of truth for every status-membership question. Predicates and sets
 * (here and in `@shared/streams/streamStatus`) are derived from this table;
 * never declare a new status list by hand.
 *
 * Traits:
 * - `active`      — a model/tool cycle is executing right now.
 * - `inFlight`    — a cycle may still append to the stream; the stream must
 *                   not be evicted or acquired by a new run.
 * - `liveElapsed` — elapsed-time displays keep advancing.
 * - `terminal`    — the current execution cycle has ended; resumption needs
 *                   an explicit user action.
 *
 * The table makes the two deliberate oddballs visible:
 * - WAITING is `terminal` AND `inFlight`: the cycle ended (status bar shows
 *   idle) but a follow-up appends to the same log, so the stream is not
 *   acquirable.
 * - INITIALIZING is neither `active` nor `terminal`: a brief pre-start state
 *   that ticks elapsed time and blocks acquisition, but runs no model calls.
 */
export const STREAM_STATUS_TRAITS = {
  [STREAM_STATUS.RUNNING]: {
    active: true,
    inFlight: true,
    liveElapsed: true,
    terminal: false,
  },
  [STREAM_STATUS.RESUMING]: {
    active: true,
    inFlight: true,
    liveElapsed: true,
    terminal: false,
  },
  [STREAM_STATUS.INITIALIZING]: {
    active: false,
    inFlight: true,
    liveElapsed: true,
    terminal: false,
  },
  [STREAM_STATUS.WAITING]: {
    active: false,
    inFlight: true,
    liveElapsed: false,
    terminal: true,
  },
  [STREAM_STATUS.STOPPED]: {
    active: false,
    inFlight: false,
    liveElapsed: false,
    terminal: true,
  },
  [STREAM_STATUS.ERROR]: {
    active: false,
    inFlight: false,
    liveElapsed: false,
    terminal: true,
  },
  [STREAM_STATUS.READY]: {
    active: false,
    inFlight: false,
    liveElapsed: false,
    terminal: true,
  },
} as const satisfies Record<
  StreamStatus,
  {
    active: boolean;
    inFlight: boolean;
    liveElapsed: boolean;
    terminal: boolean;
  }
>;

export type StreamStatusTrait =
  keyof (typeof STREAM_STATUS_TRAITS)[StreamStatus];

/** Derive the set of statuses carrying a trait — the only list constructor. */
export function streamStatusesWithTrait(
  trait: StreamStatusTrait,
): ReadonlySet<StreamStatus> {
  return new Set(
    StreamStatusSchema.options.filter(
      (status) => STREAM_STATUS_TRAITS[status][trait],
    ),
  );
}

/** Statuses whose elapsed display should keep advancing while active. */
export const LIVE_ELAPSED_STREAM_STATUSES: ReadonlySet<string> =
  streamStatusesWithTrait('liveElapsed');

export const EXECUTION_STATUS = {
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
  ERROR: 'error',
} as const;

export const ExecutionStatusSchema = z.enum(EXECUTION_STATUS);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

/**
 * Canonical terminal outcome of an agent run — the single fact "how did this
 * run end", decided exactly once at the run-lifecycle boundary. The legacy
 * vocabularies are pure projections of it (see `@shared/streams/streamStatus`):
 * `ExecutionStatus` for persisted history, `EndGroupStatus` for transcript
 * groups, `StreamStatus` for the live stream state machine.
 *
 * `cancelled` is a sibling of `failed`, never folded into it — a user stop is
 * not an error. Matches the planned `ResultEvent.outcome` triad (SDK 7d/T3-2).
 */
export const RUN_OUTCOME = {
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
} as const;

export const RunOutcomeSchema = z.enum(RUN_OUTCOME);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const EXECUTION_META_SCHEMA_VERSION = 1;

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
   * The transcript stream this execution's data lives under, once resolved.
   * Decide-once-carry-as-data cache for the execution stream resolver: absent
   * on executions whose stream wasn't resolved yet (or predate this field).
   */
  streamId: StreamTabIdSchema.optional(),
});

export const ExecutionMetaSchema = ExecutionMetaBaseSchema.transform(
  (
    meta,
  ): z.infer<typeof ExecutionMetaBaseSchema> & { outcome?: RunOutcome } => {
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
 * docs/proposals/session-scoped-runtime-architecture.md). Previously a
 * 4-value subset of the legacy `StreamStatus` (`running`/`error`/`stopped`/
 * `ready`); retyped to the native vocabulary in lockstep with its readers
 * (`logSlice.ts`, `TaskGroupList.ts`) so the completed/cancelled distinction
 * §8.2 already writes to the transcript row reaches the rendered value too.
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

export function streamStatusToPhase(status: StreamStatus): StreamPhase {
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

export function streamStatusToSubstate(
  status: StreamStatus,
): StreamSubstate | undefined {
  switch (status) {
    case STREAM_STATUS.INITIALIZING:
      return STREAM_SUBSTATE.STARTING;
    case STREAM_STATUS.RESUMING:
      return STREAM_SUBSTATE.RESUMING;
    default:
      return undefined;
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
 * Discriminated on `kind`: a stream tab is either a live LLM-driven "agent"
 * run (carries `model`/`modelLabel`) or a raw OS "process" stream such as the
 * `bash` tool (carries `command`, no meaningful model). Renderers switch on
 * `kind` instead of probing which of `model`/`command` happens to be set.
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
]);
export type StreamTabInfo = z.infer<typeof StreamTabInfoSchema>;
