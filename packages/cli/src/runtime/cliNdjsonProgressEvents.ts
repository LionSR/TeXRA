import type { SetTaskStatePayload } from '@agent/runtime/taskStateProgressPayload';
import type {
  AddOutputFilesPayload,
  ClearMissingOutputsPayload,
  GoalPausedPayload,
  GoalStateChangedPayload,
  InquiryThreadUpdatedEvent,
  RemoveStreamPayload,
  SetActiveStreamPayload,
  SetParentStreamPayload,
  UpdateConversationProgressPayload,
  UpdateActiveProcessesPayload,
  UpdateActiveSubagentsPayload,
  UpdateCompileFailuresPayload,
  UpdateMissingOutputsPayload,
  UpdatePlanPayload,
  UpdateProcessOutputPayload,
  UpdateQueuedFollowUpsPayload,
  UpdateRoundStagePayload,
  UpdateStreamDescriptionPayload,
  UpdateStreamStatusPayload,
  UpdateStreamUsagePayload,
  UpdateTodosPayload,
} from '@shared/schemas';

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
  setTaskState: SetTaskStatePayload;
  updateStreamUsage: UpdateStreamUsagePayload;
  /** Inquiry thread state changed (open, answered, dropped, or resume outcome). */
  inquiryThreadUpdated: InquiryThreadUpdatedEvent;
  updateTodos: UpdateTodosPayload;
  updatePlan: UpdatePlanPayload;
  updateConversationProgress: UpdateConversationProgressPayload;
  updateRoundStage: UpdateRoundStagePayload;
  updateQueuedFollowUps: UpdateQueuedFollowUpsPayload;
  goalPaused: GoalPausedPayload;
  updateActiveSubagents: UpdateActiveSubagentsPayload;
  updateActiveProcesses: UpdateActiveProcessesPayload;
  updateProcessOutput: UpdateProcessOutputPayload;
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
