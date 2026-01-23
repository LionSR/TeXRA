// Standard library imports
import { EventEmitter } from 'events';

// Type imports
import type { OutputFileInfo } from '@agent/output/types';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import type { StreamStatus } from '@common/constants/streamStatus';
import type { ContextStateData } from '@logger/AgentLogger';
import type { LogMessageData, LogMessageUpdate } from '@logger/LogTypes';
import type {
  AddTaskGroupPayload,
  RunScopedPayload,
  SetActiveStreamPayload,
  SetTaskStatePayload,
  UpdateTaskGroupPayload,
  UpdateTodosPayload,
} from './schemas';
import type {
  RetryRequestPrompt,
  ToolEditApprovalPrompt,
  BashApprovalPrompt,
  AgentProposalPrompt,
} from './types';

// Maximum number of events to buffer when no listeners are registered
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
  showRetryRequest: RetryRequestPrompt;
  resolveRetryRequest: { streamId: StreamTabId };
  showToolEditApprovalPrompt: ToolEditApprovalPrompt;
  resolveToolEditApprovalPrompt: { requestId: string };
  updateToolEditApprovalBypassState: {
    streamId: StreamTabId;
    bypassActive: boolean;
  };
  showBashApprovalPrompt: BashApprovalPrompt;
  resolveBashApprovalPrompt: { requestId: string };
  showAgentProposal: AgentProposalPrompt;
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
