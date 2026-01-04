// Standard library imports
import { EventEmitter } from 'events';

// Local imports - agent
import type { AgentSessionDescriptor } from '@agent/core/AgentDataclass';
import type { OutputFileInfo } from '@agent/output/types';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import type { StreamStatus } from '@common/constants/streamStatus';
import type { LogMessageData, LogMessageUpdate } from '@logger/LogTypes';
import type { TaskState } from '@logger/TaskState';
import type { ToolEditApprovalPrompt, RetryRequestPrompt } from './types';
import type {
  AddTaskGroupPayload,
  UpdateTaskGroupPayload,
  RunScopedPayload,
  UpdateTodosPayload,
} from './schemas';

// Re-export for consumers that import from this module
export type { StreamStatus };

// Re-export schema types for consumers
export type { TaskGroupStatus } from './schemas';

// Maximum number of events to buffer when no listeners are registered
const MAX_BUFFER_SIZE = 1000;

// SetActiveStreamPayload and SetTaskStatePayload are defined inline
// because they reference types from external modules (AgentSessionDescriptor, TaskState)
// that don't have schemas yet. These can be migrated when those modules are updated.
interface SetActiveStreamPayload {
  stream: StreamTabId | null;
  session?: AgentSessionDescriptor | null;
  /** Hint whether this is a remote agent (for UI display before TaskState is set) */
  isRemote?: boolean;
  /** Hint whether this agent uses multiple outputs (for UI display before TaskState is set) */
  hasMultipleOutputs?: boolean;
}

interface SetTaskStatePayload {
  streamTabId: StreamTabId;
  executionId?: ExecutionId;
  taskState: TaskState;
}

export interface ProgressEventPayloads {
  addLogMessage: { stream: StreamTabId; logMessage: LogMessageData };
  updateLogMessage: { stream: StreamTabId; logMessage: LogMessageUpdate };
  addTaskGroup: AddTaskGroupPayload;
  updateTaskGroup: UpdateTaskGroupPayload;
  setActiveStream: SetActiveStreamPayload;
  updateStreamStatus: { stream: StreamTabId; status: StreamStatus };
  addOutputFiles: RunScopedPayload & {
    filesByRound: { [key: number]: OutputFileInfo[] };
  };
  updateMissingOutputs: RunScopedPayload & {
    filesByRound: { [key: number]: string[] };
  };
  clearMissingOutputs: { stream: StreamTabId };
  setTaskState: SetTaskStatePayload;
  updateStreamUsage: RunScopedPayload & {
    usage: TokenUsageStats;
  };
  showRetryRequest: RetryRequestPrompt;
  resolveRetryRequest: { streamId: StreamTabId };
  showToolEditApprovalPrompt: ToolEditApprovalPrompt;
  resolveToolEditApprovalPrompt: { requestId: string };
  updateToolEditApprovalBypassState: { bypassActive: boolean };
  updateTodos: UpdateTodosPayload;
  extensionDeactivating: undefined;
}

export type ProgressEvent = keyof ProgressEventPayloads;

class ProgressEventBus {
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
  ): () => void {
    this.emitter.on(event, listener);
    const remaining: typeof this.buffer = [];
    for (const item of this.buffer) {
      if (item.event === event) {
        listener(item.payload as ProgressEventPayloads[K]);
      } else {
        remaining.push(item);
      }
    }
    this.buffer = remaining;
    return () => this.emitter.off(event, listener);
  }
}

export const bus = new ProgressEventBus();
