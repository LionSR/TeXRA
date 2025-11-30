// Standard library imports
import { EventEmitter } from 'events';

// Local imports - agent
import type { AgentSessionDescriptor } from '@agent/core/AgentDataclass';
import type { OutputFileInfo } from '@agent/output/types';
import type {
  StreamTabId,
  ExecutionId,
  StorageKey,
} from '@agent/types/IdentifierTypes';
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import type {
  LogMessageData,
  LogMessageUpdate,
  TaskGroup,
} from '@logger/LogTypes';
import type { TaskState } from '@logger/TaskState';

// Maximum number of events to buffer when no listeners are registered
const MAX_BUFFER_SIZE = 1000;

export type StreamStatus =
  | 'running'
  | 'error'
  | 'stopped'
  | 'waiting'
  | 'resuming';
export type StreamStatusOrReady = StreamStatus | 'ready';
export type TaskGroupStatus = TaskGroup['status'];

interface AddTaskGroupPayload {
  stream: StreamTabId;
  groupId: string;
  groupName: string;
  startTime: number;
  status: TaskGroupStatus;
  endTime?: number;
  parentGroupId?: string;
}

interface UpdateTaskGroupPayload {
  stream: StreamTabId;
  groupId: string;
  status: TaskGroupStatus;
  endTime?: number;
}

interface SetActiveStreamPayload {
  stream: StreamTabId | null;
  session?: AgentSessionDescriptor | null;
}

interface SetTaskStatePayload {
  streamTabId: StreamTabId;
  executionId?: ExecutionId;
  taskState: TaskState;
}

/**
 * Payload for storage-scoped events (files, usage, etc.).
 *
 * storageKey is THE key for storage operations - required for all events.
 */
interface RunScopedPayload {
  stream: StreamTabId;
  /** THE key for storage operations. Required. */
  storageKey: StorageKey;
  /** For metadata/audit purposes */
  executionId?: ExecutionId;
}

export interface ProgressEventPayloads {
  addLogMessage: { stream: StreamTabId; logMessage: LogMessageData };
  updateLogMessage: { stream: StreamTabId; logMessage: LogMessageUpdate };
  addTaskGroup: AddTaskGroupPayload;
  updateTaskGroup: UpdateTaskGroupPayload;
  setActiveStream: SetActiveStreamPayload;
  updateStreamStatus: { stream: StreamTabId; status: StreamStatusOrReady };
  addOutputFiles: RunScopedPayload & {
    filesByRound: { [key: number]: OutputFileInfo[] };
  };
  updateMissingOutputs: RunScopedPayload & {
    filesByRound: { [key: number]: string[] };
  };
  clearMissingOutputs: StreamTabId;
  clearOutputFiles: StreamTabId;
  setTaskState: SetTaskStatePayload;
  clearTaskOutput: StreamTabId;
  updateStreamUsage: {
    stream: StreamTabId;
    usage: TokenUsageStats;
    /** THE key for storage operations. Required. */
    storageKey: StorageKey;
  };
  showRetryRequest: {
    streamId: StreamTabId;
    operation: string;
    model?: string;
    errorMessage?: string;
  };
  resolveRetryRequest: { streamId: StreamTabId };
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
