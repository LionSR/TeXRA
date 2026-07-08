import type { TaskState } from '@agent/core/state/TaskState';
import type {
  AddOutputFilesPayload,
  AgentProposalPermission,
  BashPermission,
  ClearMissingOutputsPayload,
  ConversationProgress,
  ExecutionId,
  ExternalInquiryPermission,
  GoalPausedPayload,
  GoalStateChangedPayload,
  InquiryThreadUpdatedEvent,
  PlanApprovalPermission,
  RemoveStreamPayload,
  RequestEnsureProgressViewPayload,
  RequestOpenFilePayload,
  RequestShowErrorPayload,
  RequestShowInstructionPayload,
  RetryPermission,
  SetActiveStreamPayload,
  SetParentStreamPayload,
  ShowAgentConfigBannerPayload,
  StreamTabId,
  ToolEditPermission,
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
  UserQuestionPermission,
} from '@shared/schemas';

/**
 * **Frozen** legacy host progress-event view, spoken by
 * `AgentRuntimeHost.emit` and `HostInteractions.handleProgressEvent`.
 * Retained CLI public output now projects into this table inside the CLI
 * adapter boundary (D3 decision on #6984: frozen until v0.41).
 *
 * Do NOT add keys. The payload vocabulary lives as fact-native named types in
 * `@shared/schemas` (`progressEvents.ts` and friends); new run-scoped facts
 * extend `AgentEvent` (trace), and new session-scoped facts extend
 * `SessionFact` (`SessionEventHub`). The process-wide carrier that originally
 * carried these keys is deleted; this map survives only so the retained host
 * rails keep one shared key/payload table while they are migrated to typed
 * session/host surfaces.
 * Every fact-plane key below references its named vocabulary type — this map
 * projects the vocabulary, it does not define it. Keys still typed inline are
 * not facts: host-rail status/RPC keys plus the remaining Stage-5 residue
 * (`setTaskState`).
 */
export interface ProgressEventPayloads {
  // ── Run/stream progress ──
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
  // ── Approval / permission RPC ──
  // The show* keys are synthesized by the CLI approval adapter from typed
  // `HostInteractions` requests; only tool-edit show/resolve still flows on
  // the host rail itself (src/tools/approval + native approval paths).
  showRetryRequest: RetryPermission;
  showToolEditPermission: ToolEditPermission;
  resolveToolEditPermission: { requestId: string };
  updateToolEditApprovalBypassState: {
    streamId: StreamTabId;
    bypassActive: boolean;
  };
  updateBashApprovalBypassState: {
    streamId: StreamTabId;
    bypassActive: boolean;
  };
  updateSuperYoloBypassState: {
    streamId: StreamTabId;
    bypassActive: boolean;
  };
  showBashPermission: BashPermission;
  showAgentProposal: AgentProposalPermission;
  showPlanApproval: PlanApprovalPermission;
  showExternalInquiry: ExternalInquiryPermission;
  /** Inquiry thread state changed (open, answered, dropped, or resume outcome). */
  inquiryThreadUpdated: InquiryThreadUpdatedEvent;
  showUserQuestion: UserQuestionPermission;
  // ── Run/stream progress (part 2) ──
  updateTodos: UpdateTodosPayload;
  updatePlan: UpdatePlanPayload;
  updateConversationProgress: {
    streamId: StreamTabId;
    progress: ConversationProgress;
  };
  updateRoundStage: UpdateRoundStagePayload;
  updateQueuedFollowUps: UpdateQueuedFollowUpsPayload;
  goalPaused: GoalPausedPayload;
  updateActiveSubagents: UpdateActiveSubagentsPayload;
  updateActiveProcesses: UpdateActiveProcessesPayload;
  updateProcessOutput: UpdateProcessOutputPayload;
  updateStreamDescription: UpdateStreamDescriptionPayload;
  setParentStream: SetParentStreamPayload;

  /** Request the progress view to remove a stream tab (used by short-lived
   *  child streams that should auto-close once their work is done). */
  removeStream: RemoveStreamPayload;

  goalStateChanged: GoalStateChangedPayload;

  // ── Frontend-bound presentation requests ──
  // Emitted by agent core/runtime; consumed by host presentation listeners
  // (the extension routes these through `extensionPresentationEvents`).
  requestOpenFile: RequestOpenFilePayload;
  requestShowInstruction: RequestShowInstructionPayload;
  showAgentConfigBanner: ShowAgentConfigBannerPayload;
  requestShowError: RequestShowErrorPayload;
  requestEnsureProgressView: RequestEnsureProgressViewPayload;
}

export type ProgressEvent = keyof ProgressEventPayloads;
