import { EventEmitter } from 'events';

import type { AgentCategory } from '@agent/core/AgentDataclass';
import type { TaskState } from '@logger/TaskState';
import type {
  AddTaskGroupPayload,
  AgentProposalPermission,
  BashPermission,
  ContextStateData,
  ExecutionId,
  LogMessageData,
  LogMessageUpdate,
  OutputFileInfo,
  RetryPermission,
  StorageKey,
  StreamStatus,
  StreamTabId,
  TokenUsageStats,
  ToolEditPermission,
  UpdateTaskGroupPayload,
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
}

const MAX_BUFFER_SIZE = 1000;

export interface ProgressEventPayloads {
  addLogMessage: { streamId: StreamTabId; logMessage: LogMessageData };
  updateLogMessage: { streamId: StreamTabId; logMessage: LogMessageUpdate };
  addTaskGroup: AddTaskGroupPayload;
  updateTaskGroup: UpdateTaskGroupPayload;
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
  updateContextState: {
    streamId: StreamTabId;
    contextState: ContextStateData;
  };
  showRetryRequest: RetryPermission;
  resolveRetryRequest: { streamId: StreamTabId };
  showToolEditPermission: ToolEditPermission;
  resolveToolEditPermission: { requestId: string };
  updateToolEditApprovalBypassState: {
    streamId: StreamTabId;
    bypassActive: boolean;
  };
  showBashPermission: BashPermission;
  resolveBashPermission: { requestId: string };
  showAgentProposal: AgentProposalPermission;
  resolveAgentProposal: { proposalId: string };
  updateTodos: UpdateTodosPayload;
  updateQueuedFollowUps: { streamId: StreamTabId };
  extensionDeactivating: undefined;
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
