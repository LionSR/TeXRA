import { EventEmitter } from 'events';

import type { AgentCategory } from '@agent/core/AgentDataclass';
import type { TaskState } from '@logger/TaskState';
import type {
  ActiveChildInfo,
  AddTaskGroupPayload,
  AgentProposalPermission,
  BashPermission,
  ConversationProgress,
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

/**
 * Per-event-type buffer limit. Prevents one noisy event type (e.g., addLogMessage)
 * from evicting critical events of other types during the startup buffering window.
 * Kept at 1000 (same as the previous global limit) so no single type regresses in capacity.
 */
const PER_TYPE_BUFFER_LIMIT = 1000;

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
  updateSuperYoloBypassState: {
    streamId: StreamTabId;
    bypassActive: boolean;
    featureEnabled: boolean;
  };
  showBashPermission: BashPermission;
  resolveBashPermission: { requestId: string };
  showAgentProposal: AgentProposalPermission;
  resolveAgentProposal: { proposalId: string };
  updateTodos: UpdateTodosPayload;
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
  setParentStream: {
    childStreamId: StreamTabId;
    parentStreamId: StreamTabId;
  };
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
  /** Remove all buffered events associated with a specific stream. */
  clearStream(streamId: string): void;
  /** Remove all buffered events. */
  clear(): void;
}

/**
 * Check whether a payload is scoped to a specific stream.
 * Handles all stream-identifying fields used across event payloads.
 */
function isStreamPayload(payload: unknown, streamId: string): boolean {
  if (payload === null || payload === undefined || typeof payload !== 'object') {
    return false;
  }
  const p = payload as Record<string, unknown>;
  return (
    p.streamId === streamId ||
    p.parentStreamId === streamId ||
    p.childStreamId === streamId
  );
}

class ProgressEventBus implements ProgressEventBusLike {
  private emitter = new EventEmitter();
  /** Per-event-type buffer. Replaces the old flat array to prevent cross-type eviction. */
  private eventStore = new Map<
    ProgressEvent,
    ProgressEventPayloads[ProgressEvent][]
  >();

  emit<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    if (this.emitter.listenerCount(event) === 0) {
      let entries = this.eventStore.get(event);
      if (!entries) {
        entries = [];
        this.eventStore.set(event, entries);
      }
      entries.push(payload);
      if (entries.length > PER_TYPE_BUFFER_LIMIT) {
        entries.shift();
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

    // Replay buffered events for this event type and remove them
    const buffered = this.eventStore.get(event);
    if (buffered?.length) {
      this.eventStore.delete(event);
      for (const payload of buffered) {
        listener(payload as ProgressEventPayloads[K]);
      }
    }

    return cleanup;
  }

  clearStream(streamId: string): void {
    for (const [event, entries] of this.eventStore) {
      const filtered = entries.filter(
        (payload) => !isStreamPayload(payload, streamId),
      );
      if (filtered.length === 0) {
        this.eventStore.delete(event);
      } else if (filtered.length < entries.length) {
        this.eventStore.set(event, filtered);
      }
    }
  }

  clear(): void {
    this.eventStore.clear();
  }
}

export const bus = new ProgressEventBus();
