import { EventEmitter } from 'events';

import type { AgentCategory } from '@agent/core/AgentDataclass';
import type { TaskState } from '@logger/TaskState';
import type {
  ActiveChildInfo,
  AgentProposalPermission,
  BashPermission,
  ConversationProgress,
  ExecutionId,
  ExternalInquiryPermission,
  FileLocation,
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
} from '@shared/schemas';

/** Payload for events scoped to a specific run (stream + storage key). */
interface RunScopedPayload {
  streamId: StreamTabId;
  storageKey: StorageKey;
  executionId?: ExecutionId;
}

interface SetActiveStreamPayload {
  streamId: StreamTabId | null;
  agentCategory?: AgentCategory;
  /** Hint whether this is a remote agent (for UI display before TaskState is set) */
  isRemote?: boolean;
  /** Hint whether this agent uses multiple outputs (for UI display before TaskState is set) */
  hasMultipleOutputs?: boolean;
}

interface SetTaskStatePayload {
  streamId: StreamTabId;
  executionId?: ExecutionId;
  taskState: TaskState;
  /** Storage key for this run (root group ID). Sets activeRunId so instruction
   *  persistence works immediately, not after the first usage event. */
  storageKey: StorageKey;
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
  addOutputFiles: RunScopedPayload & {
    filesByRound: { [key: number]: OutputFileInfo[] };
  };
  updateMissingOutputs: RunScopedPayload & {
    filesByRound: { [key: number]: string[] };
  };
  clearMissingOutputs: { streamId: StreamTabId };
  setTaskState: SetTaskStatePayload;
  updateStreamUsage: RunScopedPayload & {
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
    featureEnabled: boolean;
  };
  showBashPermission: BashPermission;
  resolveBashPermission: { requestId: string };
  showAgentProposal: AgentProposalPermission;
  resolveAgentProposal: { proposalId: string };
  showPlanApproval: PlanApprovalPermission;
  resolvePlanApproval: { approvalId: string };
  showExternalInquiry: ExternalInquiryPermission;
  resolveExternalInquiry: { requestId: string };
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
    parentStreamId: StreamTabId;
  };
  extensionDeactivating: undefined;

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
    if (options?.signal?.aborted) {
      return () => {};
    }

    this.emitter.on(event, listener);

    const cleanup = () => this.emitter.off(event, listener);
    options?.signal?.addEventListener('abort', cleanup, { once: true });

    // Replay buffered events for this event type and remove them (single pass)
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
