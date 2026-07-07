import type { TaskState } from '@agent/core/state/TaskState';
import type {
  ActiveChildInfo,
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
  RequestEnsureProgressViewPayload,
  RequestOpenFilePayload,
  RequestShowErrorPayload,
  RequestShowInstructionPayload,
  RetryPermission,
  RoundStage,
  SetActiveStreamPayload,
  ShowAgentConfigBannerPayload,
  StreamPhase,
  StreamSubstate,
  StreamTabId,
  ToolEditPermission,
  UpdateCompileFailuresPayload,
  UpdateMissingOutputsPayload,
  UpdatePlanPayload,
  UpdateQueuedFollowUpsPayload,
  UpdateStreamUsagePayload,
  UpdateTodosPayload,
  UserQuestionPermission,
} from '@shared/schemas';

/**
 * **Frozen** legacy host progress-event view, spoken by
 * `AgentRuntimeHost.emit` and `HostInteractions.handleProgressEvent`, and
 * projected from the session fact plane by
 * `sessionProgressEventProjection.ts` for the retained CLI public output
 * (D3 decision on #6984: frozen until v0.41).
 *
 * Do NOT add keys. The payload vocabulary lives as fact-native named types in
 * `@shared/schemas` (`progressEvents.ts` and friends); new run-scoped facts
 * extend `AgentEvent` (trace), and new session-scoped facts extend
 * `SessionFact` (`SessionEventHub`). The process-wide `ProgressEventBus` that
 * originally carried these keys is deleted; this map survives only so the
 * retained host rails keep one shared key/payload table while they are
 * migrated to typed session/host surfaces.
 */
export interface ProgressEventPayloads {
  // ── Run/stream progress ──
  setActiveStream: SetActiveStreamPayload;
  updateStreamStatus: {
    streamId: StreamTabId;
    status: StreamPhase;
    /** Previous phase before this update, for detecting transitions. */
    previousStatus?: StreamPhase;
    /** Narrower in-flight display state for launch/resume overlays. */
    substate?: StreamSubstate;
  };
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
  updateRoundStage: {
    streamId: StreamTabId;
    roundStage: RoundStage;
  };
  updateQueuedFollowUps: UpdateQueuedFollowUpsPayload;
  goalPaused: GoalPausedPayload;
  updateActiveSubagents: {
    parentStreamId: StreamTabId;
    children: ActiveChildInfo[];
  };
  updateActiveProcesses: {
    parentStreamId: StreamTabId;
    processes: ActiveChildInfo[];
  };
  updateProcessOutput: {
    parentStreamId: StreamTabId;
    executionId: ExecutionId;
    stdout: string;
    stderr: string;
  };
  updateStreamDescription: {
    streamId: StreamTabId;
    description: string;
  };
  setParentStream: {
    childStreamId: StreamTabId;
    parentStreamId: StreamTabId | null;
  };
  /** A follow-up message was sent to an active tool-use session.
   *  Listened by blocking tools (e.g. ExecutionsTool wait) to abort early. */
  followUpSent: { streamId: StreamTabId };

  /** Request the progress view to remove a stream tab (used by short-lived
   *  child streams that should auto-close once their work is done). */
  removeStream: { streamId: StreamTabId };

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
