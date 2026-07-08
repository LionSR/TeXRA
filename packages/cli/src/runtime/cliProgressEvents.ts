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
 * Progress payloads retained for CLI public-output compatibility.
 *
 * Session- and run-scoped state changes are owned by `SessionEventHub` and
 * `AgentEvent`; this table only types the remaining explicit progress sink
 * used by CLI compatibility adapters. Do not add new fact keys here. New
 * durable state should extend the session/run fact vocabulary first, then
 * choose an explicit host projection only when a retained public surface
 * requires it.
 */
export interface CliProgressEventPayloads {
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

export type CliProgressEvent = keyof CliProgressEventPayloads;

export interface CliProgressSink {
  emit<K extends CliProgressEvent>(
    event: K,
    payload: CliProgressEventPayloads[K],
  ): void;
}
