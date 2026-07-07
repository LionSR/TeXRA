import { EventEmitter } from 'node:events';

import type { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { TaskState } from '@agent/core/state/TaskState';
import type {
  ActiveChildInfo,
  AgentProposalPermission,
  BashPermission,
  CompileFailure,
  ConversationProgress,
  ExecutionId,
  ExternalInquiryPermission,
  FileLocation,
  InquiryThreadUpdatedEvent,
  OutputFileInfo,
  PlanApprovalPermission,
  RetryPermission,
  RoundIndexed,
  RoundStage,
  StorageKey,
  StreamPhase,
  StreamSubstate,
  StreamTabId,
  TokenUsageStats,
  ToolEditPermission,
  UpdatePlanPayload,
  UpdateTodosPayload,
  UserQuestionPermission,
} from '@shared/schemas';

/** Payload for stream-scoped output events (one run per workflow tab). */
interface StreamScopedPayload {
  streamId: StreamTabId;
  executionId?: ExecutionId;
}

/** Payload for usage events. Tool-use can resume → multiple runs per tab. */
interface UsageScopedPayload {
  streamId: StreamTabId;
  storageKey: StorageKey;
  executionId?: ExecutionId;
}

interface SetActiveStreamPayload {
  streamId: StreamTabId | null;
  agentCategory?: AgentCategory;
  /** Hint whether this is a remote agent (for UI display before TaskState is set) */
  isRemote?: boolean;
  /**
   * When true, register the stream (state, logs, hints) but do NOT switch the
   * active tab to it. Used by background child streams (bash, codex) so the
   * stream tab appears without yanking the user away from their current view.
   */
  suppressViewSwitch?: boolean;
}

interface SetTaskStatePayload {
  streamId: StreamTabId;
  executionId?: ExecutionId;
  taskState: TaskState;
}

const MAX_BUFFER_SIZE = 1000;

/**
 * Host-agnostic action tokens for {@link ProgressEventPayloads.requestShowInstruction}.
 * The agent core emits a token; each host maps it to its own UI affordance
 * (the VS Code extension to a command + button title, other hosts as they see
 * fit). This keeps host-specific command IDs and labels out of the VS Code-free
 * agent core.
 */
export const INSTRUCTION_ACTION = {
  SET_API_KEY: 'set-api-key',
  OPEN_CONFIGURATION_GUIDE: 'open-configuration-guide',
  OPEN_MODELS_DOC: 'open-models-doc',
} as const;

export type InstructionAction =
  (typeof INSTRUCTION_ACTION)[keyof typeof INSTRUCTION_ACTION];

/**
 * Every payload this bus carries, grouped below by what it actually reports —
 * not one channel with one owner. It mixes run/stream progress facts, approval
 * request/resolve RPC pairs, app-lifecycle and integration signals, and
 * host-presentation requests, with delivery depending on which host
 * re-published a given event rather than on what kind of event it is. This is
 * a known, tracked shape, not an oversight: see `docs/proposals/
 * error-pipeline-and-ownership.md` (Map 3) for the audit and the planned
 * run-scoped/app-scoped split gated on SDK Step 7d. Until that split lands,
 * treat the section comments below as the de facto ownership boundaries when
 * deciding where a new event belongs.
 */
export interface ProgressEventPayloads {
  // ── Run/stream progress (part 1) ──
  setActiveStream: SetActiveStreamPayload;
  updateStreamStatus: {
    streamId: StreamTabId;
    status: StreamPhase;
    /** Previous phase before this update, for detecting transitions. */
    previousStatus?: StreamPhase;
    /** Narrower in-flight display state for launch/resume overlays. */
    substate?: StreamSubstate;
  };
  addOutputFiles: StreamScopedPayload & {
    filesByRound: RoundIndexed<OutputFileInfo>;
  };
  updateMissingOutputs: StreamScopedPayload & {
    filesByRound: RoundIndexed<string>;
  };
  updateCompileFailures: StreamScopedPayload & {
    filesByRound: RoundIndexed<CompileFailure>;
  };
  /**
   * Clear the "missing outputs" marker. Either target a specific tab via
   * `streamId`, or clear every workflow tab whose taskState matches the
   * given `streamConfig` (for command-palette pack/clean which has no
   * stream context).
   */
  clearMissingOutputs:
    | { streamId: StreamTabId; streamConfig?: undefined }
    | {
        streamId?: undefined;
        streamConfig: {
          agent: string;
          model: string;
          inputFile: string;
          outputFiles?: readonly string[];
        };
      };
  setTaskState: SetTaskStatePayload;
  updateStreamUsage: UsageScopedPayload & {
    usage: TokenUsageStats;
  };
  // ── Approval / permission RPC (show*/resolve* request-response pairs) ──
  showRetryRequest: RetryPermission;
  resolveRetryRequest: { streamId: StreamTabId };
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
  resolveBashPermission: { requestId: string };
  showAgentProposal: AgentProposalPermission;
  resolveAgentProposal: { proposalId: string };
  showPlanApproval: PlanApprovalPermission;
  resolvePlanApproval: { approvalId: string };
  showExternalInquiry: ExternalInquiryPermission;
  resolveExternalInquiry: { requestId: string };
  /** Inquiry thread state changed (open, answered, dropped, or resume outcome). */
  inquiryThreadUpdated: InquiryThreadUpdatedEvent;
  showUserQuestion: UserQuestionPermission;
  resolveUserQuestion: { requestId: string };
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
  updateQueuedFollowUps: { streamId: StreamTabId };
  /**
   * An autonomous goal auto-paused after a failed cycle ended the
   * autonomous leg. Hosts surface this so a paused goal is
   * distinguishable from a hang.
   */
  goalPaused: { streamId: StreamTabId };
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

  /** Emitted whenever a Goal record mutates (start/pause/resume/
   *  complete/abandon/edit-objective/cap-reached) so UI surfaces (header
   *  chip, settings tab, progress board) can refresh. The agent owns state
   *  transitions through the plan tool; the bus event is how those flow
   *  back to the UI. */
  goalStateChanged: { streamId: StreamTabId };

  // ── Frontend-bound events ──
  // Emitted by agent core/runtime; consumed by frontend listeners.
  // Keeps @agent/ free of @frontend/ imports.

  /** Request the frontend to open a file (and build+display if LaTeX). */
  requestOpenFile: {
    location: FileLocation;
    preserveFocus: boolean;
  };
  /** Request the frontend to show a suppressible instruction message. */
  requestShowInstruction: {
    key: string;
    message: string;
    /**
     * Host-agnostic action tokens rendered as buttons. The host maps each
     * token to its own UI affordance (see {@link INSTRUCTION_ACTION}).
     */
    actions?: InstructionAction[];
    showSuppress?: boolean;
  };
  /** Request the frontend to show the agent-config banner in the main webview. */
  showAgentConfigBanner: {
    agentName: string;
  };
  /** Request the frontend to show an error message via VS Code notification. */
  requestShowError: {
    message: string;
  };
  /**
   * Request the frontend to ensure the progress view is visible.
   * If the view cannot be opened and a fallback notification is provided,
   * show a toast notification as a last resort.
   */
  requestEnsureProgressView: {
    fallbackNotification?: {
      agentName: string;
      modelName: string;
      inputName: string;
      outputInfo: string;
    };
  };
}

export type ProgressEvent = keyof ProgressEventPayloads;

/**
 * Interface for the progress event bus.
 * Used by event handler modules for testability and dependency injection.
 */
export interface ProgressEventBusLike {
  on<K extends ProgressEvent>(
    event: K,
    listener: (payload: ProgressEventPayloads[K]) => void,
    options?: { signal?: AbortSignal },
  ): () => void;
  emit<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void;
}

class ProgressEventBusImpl implements ProgressEventBusLike {
  private emitter = new EventEmitter();
  private buffer: {
    event: ProgressEvent;
    payload: ProgressEventPayloads[ProgressEvent];
  }[] = [];

  emit<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    if (this.emitter.listenerCount(event) === 0) {
      this.buffer.push({ event, payload });
      if (this.buffer.length > MAX_BUFFER_SIZE) {
        this.buffer.shift();
      }
    } else {
      this.emitter.emit(event, payload);
    }
  }

  on<K extends ProgressEvent>(
    event: K,
    listener: (payload: ProgressEventPayloads[K]) => void,
    options?: { signal?: AbortSignal },
  ): () => void {
    if (options?.signal?.aborted) return () => {};

    this.emitter.on(event, listener);
    const cleanup = (): void => {
      this.emitter.off(event, listener);
    };
    options?.signal?.addEventListener('abort', cleanup, { once: true });

    const remaining: typeof this.buffer = [];
    for (const item of this.buffer) {
      if (item.event === event) {
        listener(item.payload as ProgressEventPayloads[K]);
      } else {
        remaining.push(item);
      }
    }
    this.buffer = remaining;

    return cleanup;
  }
}

export const ProgressEventBus = new ProgressEventBusImpl();
