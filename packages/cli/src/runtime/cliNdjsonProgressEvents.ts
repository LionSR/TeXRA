/**
 * The 0.40 wire's stream and execution ids are one run id: this module keeps
 * the frozen key names (`streamId`, `executionId`, `childStreamId`,
 * `parentStreamId`, `storageKey`) over that one value until S5 versions the
 * projection.
 */

import type { agentConfigToTaskState } from '@agent/runtime';
import type {
  AddOutputFilesPayload,
  AgentCategory,
  ConversationProgress,
  ExtendedTokenUsageStats,
  InquiryThreadUpdatedEvent,
  RoundStage,
  RunId,
  RunPhase,
  RunSubstate,
  UpdateCompileFailuresPayload,
  UpdateMissingOutputsPayload,
  UpdatePlanPayload,
  UpdateTodosPayload,
} from '@shared/schemas';

/** The frozen `updateStreamUsage` line: `storageKey` is the run the usage
 *  belongs to, under the field name the 0.40 wire promised. */
export interface UpdateStreamUsagePayload {
  streamId: RunId;
  storageKey: RunId;
  usage: ExtendedTokenUsageStats;
}

// Derived rather than deep-imported from '@agent/core/state/TaskState', so the
// cli host does not pin @agent's internal module layout for one payload type.
type TaskState = ReturnType<typeof agentConfigToTaskState>;

/**
 * Frozen public `updateActiveSubagents` row — the pre-consolidation
 * `ActiveChildInfo` shape, discriminated by `kind` with no `identity` struct.
 * The internal roster now carries the parsed `identity` verbatim; the NDJSON
 * boundary alone projects it back so `--output-format ndjson` consumers keep
 * the old wire shape (proposal gate G).
 */
export interface CliNdjsonActiveChildRow {
  readonly kind: 'subagent' | 'process';
  readonly executionId: string;
  readonly agentName: string;
  readonly status?: RunPhase;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly elapsed?: string | null;
  readonly workflowPhase?: string;
  /** Tool that spawned this child (e.g. "bash", "codex"); omitted for a
   *  native agent child. */
  readonly toolName?: string;
  /** Only on `kind: 'subagent'` rows — the child's own run id, spelled the
   *  way the 0.40 wire promised. */
  readonly childStreamId?: string;
}

/**
 * Frozen public `setActiveStream` record: the pre-fold stream attachment
 * shape, now projected from the run's `run.activate`. The internal fact that
 * carried it is gone (existence is `run.start`; focus is never a fact), and
 * the NDJSON boundary alone keeps the record name and fields.
 */
interface CliNdjsonSetActiveStreamPayload {
  readonly streamId: RunId;
  readonly agentCategory?: AgentCategory;
  readonly isRemote?: boolean;
  /** Present, and true, only on a delegated child's activation: the parent
   *  edge of its `run.start`, spelled the way the 0.40 wire promised. */
  readonly suppressViewSwitch?: true;
}

/**
 * Progress payloads retained only for CLI NDJSON public-output compatibility.
 *
 * Session- and run-scoped state changes are owned by `SessionEvent` and
 * `AgentEvent`; this table only types the remaining `kind: "progress"` record
 * names in `--output-format ndjson`. It is not a runtime-host event bus. Do
 * not add new fact keys here. New durable state should extend the session/run
 * fact vocabulary first, then choose an explicit NDJSON projection only when a
 * retained public output surface requires it.
 */
export interface CliNdjsonProgressEventPayloads {
  // Run/stream progress.
  setActiveStream: CliNdjsonSetActiveStreamPayload;
  updateStreamStatus: {
    streamId: RunId;
    status: RunPhase;
    /** Diagnostic transition cause retained for public output. */
    cause?: string;
    /** Previous phase before this update, for detecting transitions. */
    previousStatus?: RunPhase;
    /** Narrower in-flight display state for launch/resume overlays. */
    substate?: RunSubstate;
  };
  addOutputFiles: {
    streamId: RunId;
    filesByRound: AddOutputFilesPayload['filesByRound'];
  };
  updateMissingOutputs: {
    streamId: RunId;
    filesByRound: UpdateMissingOutputsPayload['filesByRound'];
  };
  updateCompileFailures: {
    streamId: RunId;
    filesByRound: UpdateCompileFailuresPayload['filesByRound'];
  };
  setTaskState: {
    streamId: RunId;
    executionId?: RunId;
    taskState: TaskState;
  };
  updateStreamUsage: UpdateStreamUsagePayload;
  /** Inquiry thread state changed (open, answered, dropped, or resume outcome).
   *  The internal edge is the asking run under the 0.40 key. */
  inquiryThreadUpdated: Omit<InquiryThreadUpdatedEvent, 'parentRunId'> & {
    readonly parentStreamId: RunId | null;
  };
  updateTodos: { streamId: RunId; todos: UpdateTodosPayload['todos'] };
  updatePlan: { streamId: RunId; plan: UpdatePlanPayload['plan'] };
  updateConversationProgress: {
    streamId: RunId;
    progress: ConversationProgress;
  };
  /** Round advance projected from stage.start with kind round. */
  updateRoundStage: { streamId: RunId; roundStage: RoundStage };
  updateQueuedFollowUps: { streamId: RunId };
  goalPaused: { streamId: RunId };
  updateActiveSubagents: {
    parentStreamId: RunId;
    children: CliNdjsonActiveChildRow[];
  };
  updateStreamDescription: { streamId: RunId; description: string };
  setParentStream: {
    childStreamId: RunId;
    parentStreamId: RunId | null;
  };

  /**
   * Request the progress view to remove a run. This is used by short-lived
   * child runs that should auto-close once their work is done.
   */
  removeStream: { streamId: RunId };

  goalStateChanged: { streamId: RunId };
}

export type CliNdjsonProgressEvent = keyof CliNdjsonProgressEventPayloads;
