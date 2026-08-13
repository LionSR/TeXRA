import type { TaskState } from '@agent/core/state/TaskState';
import type {
  AddOutputFilesPayload,
  ClearMissingOutputsPayload,
  ExecutionId,
  GoalPausedPayload,
  GoalStateChangedPayload,
  InquiryThreadUpdatedEvent,
  RemoveStreamPayload,
  SetActiveStreamPayload,
  SetParentStreamPayload,
  StreamPhase,
  StreamTabId,
  UpdateConversationProgressPayload,
  UpdateCompileFailuresPayload,
  UpdateMissingOutputsPayload,
  UpdatePlanPayload,
  UpdateQueuedFollowUpsPayload,
  UpdateRoundStagePayload,
  UpdateStreamDescriptionPayload,
  UpdateStreamStatusPayload,
  UpdateStreamUsagePayload,
  UpdateTodosPayload,
} from '@shared/schemas';

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
  readonly status?: StreamPhase;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly elapsed?: string | null;
  readonly workflowPhase?: string;
  /** Tool that spawned this child (e.g. "bash", "codex"); omitted for a
   *  native agent child. */
  readonly toolName?: string;
  /** Only on `kind: 'subagent'` rows — subagents own a stream tab. */
  readonly childStreamId?: string;
}

/**
 * Progress payloads retained only for CLI NDJSON public-output compatibility.
 *
 * Session- and run-scoped state changes are owned by `SessionEventHub` and
 * `AgentEvent`; this table only types the remaining `kind: "progress"` record
 * names in `--output-format ndjson`. It is not a runtime-host event bus. Do
 * not add new fact keys here. New durable state should extend the session/run
 * fact vocabulary first, then choose an explicit NDJSON projection only when a
 * retained public output surface requires it.
 */
export interface CliNdjsonProgressEventPayloads {
  // Run/stream progress.
  setActiveStream: SetActiveStreamPayload;
  updateStreamStatus: UpdateStreamStatusPayload;
  addOutputFiles: AddOutputFilesPayload;
  updateMissingOutputs: UpdateMissingOutputsPayload;
  updateCompileFailures: UpdateCompileFailuresPayload;
  clearMissingOutputs: ClearMissingOutputsPayload;
  setTaskState: {
    streamId: StreamTabId;
    executionId?: ExecutionId;
    taskState: TaskState;
  };
  updateStreamUsage: UpdateStreamUsagePayload;
  /** Inquiry thread state changed (open, answered, dropped, or resume outcome). */
  inquiryThreadUpdated: InquiryThreadUpdatedEvent;
  updateTodos: UpdateTodosPayload;
  updatePlan: UpdatePlanPayload;
  updateConversationProgress: UpdateConversationProgressPayload;
  updateRoundStage: UpdateRoundStagePayload;
  updateQueuedFollowUps: UpdateQueuedFollowUpsPayload;
  goalPaused: GoalPausedPayload;
  updateActiveSubagents: {
    parentStreamId: StreamTabId;
    children: CliNdjsonActiveChildRow[];
  };
  updateStreamDescription: UpdateStreamDescriptionPayload;
  setParentStream: SetParentStreamPayload;

  /**
   * Request the progress view to remove a stream tab. This is used by
   * short-lived child streams that should auto-close once their work is done.
   */
  removeStream: RemoveStreamPayload;

  goalStateChanged: GoalStateChangedPayload;
}

export type CliNdjsonProgressEvent = keyof CliNdjsonProgressEventPayloads;
