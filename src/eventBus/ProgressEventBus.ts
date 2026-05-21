import { EventEmitter } from 'events';

import type { AgentCategory } from '@agent/core/AgentDataclass';
import type { TaskState } from '@logger/TaskState';
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
  StorageKey,
  StreamStatus,
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

export interface ProgressEventPayloads {
  setActiveStream: SetActiveStreamPayload;
  updateStreamStatus: {
    streamId: StreamTabId;
    status: StreamStatus;
    /** Previous status before this update, for detecting transitions */
    previousStatus: StreamStatus;
  };
  addOutputFiles: StreamScopedPayload & {
    filesByRound: { [key: number]: OutputFileInfo[] };
  };
  updateMissingOutputs: StreamScopedPayload & {
    filesByRound: { [key: number]: string[] };
  };
  updateCompileFailures: StreamScopedPayload & {
    filesByRound: { [key: number]: CompileFailure[] };
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
  showRetryRequest: RetryPermission;
  resolveRetryRequest: { streamId: StreamTabId };
  showToolEditPermission: ToolEditPermission;
  resolveToolEditPermission: { requestId: string };
  updateToolEditApprovalBypassState: {
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
  updateTodos: UpdateTodosPayload;
  updatePlan: UpdatePlanPayload;
  updateConversationProgress: {
    streamId: StreamTabId;
    progress: ConversationProgress;
  };
  updateQueuedFollowUps: { streamId: StreamTabId };
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

  /** Emitted whenever an Odyssey record mutates (start/pause/resume/
   *  complete/abandon/edit-objective/cap-reached) so UI surfaces (header
   *  chip, settings tab, progress board) can refresh. The agent owns state
   *  transitions through the plan tool; the bus event is how those flow
   *  back to the UI. */
  odysseyStateChanged: { streamId: StreamTabId };

  extensionDeactivating: undefined;

  /**
   * Emitted when PR-activity polling is rejected by GitHub (401/403 auth).
   * The frontend shows a toast prompting the user to replace the token.
   */
  githubTokenInvalid: { message: string };

  /** Active PR-activity subscription keys changed; frontends refresh their list. */
  prSubscriptionsChanged: { keys: readonly string[] };
  /** Active PR-activity owners changed; frontends refresh owner metadata. */
  prSubscriptionBindingsChanged: undefined;
  /** Active repo-activity subscription keys changed. */
  repoSubscriptionsChanged: { keys: readonly string[] };
  /** Active repo-activity owners changed. */
  repoSubscriptionBindingsChanged: undefined;
  /** Active issue-activity subscription keys changed. */
  issueSubscriptionsChanged: { keys: readonly string[] };
  /** Active issue-activity owners changed. */
  issueSubscriptionBindingsChanged: undefined;

  /**
   * External tool availability was re-probed. Frontends (Tools tab) refresh
   * their dashboard from the updated cache. Emitted by
   * {@link refreshToolAvailability}.
   */
  toolAvailabilityChanged: undefined;

  /**
   * One or more files were written directly to the workspace (e.g. via
   * accept_run_files). Listened by fileDecorations to badge the files.
   */
  workspaceFilesWritten: { absolutePaths: string[] };

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
    /** Actions rendered as buttons. Each maps to a VS Code command. */
    actions?: { title: string; command: string; args?: unknown[] }[];
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

class ProgressEventBus implements ProgressEventBusLike {
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

export const bus = new ProgressEventBus();
