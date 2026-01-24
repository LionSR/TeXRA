// Local imports
import type {
  InstructionUpdate,
  LogMessageData,
  OutputFileInfo,
  StreamStatus,
  StreamTabInfo,
  StreamTabId,
  TaskGroup,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';

export type StreamFilter = 'all' | 'workflow' | 'toolUse';
export type StreamSort = 'time' | 'agent' | 'inputFile';

export interface ContextState {
  inputTokens: number;
  contextWindow: number;
  utilizationPercent: number;
}

export interface StreamState {
  info?: StreamTabInfo;
  status?: StreamStatus;
  logs: LogMessageData[];
  taskGroups: Map<string, TaskGroup>;
  todos: TodoItem[];
  queuedFollowUps: string[];
  runInstructions: Map<string, InstructionUpdate>;
  runUsage: Map<string, TokenUsageStats>;
  runFiles: Map<string, Map<number, OutputFileInfo[]>>;
  runMissingOutputs: Map<string, Map<number, string[]>>;
  activeRunId: string | null;
  selectedRunId: string | null;
  contextState?: ContextState;
  toolEditBypass?: boolean;
}

export interface ProgressState {
  activeStreamId: StreamTabId | null;
  streams: StreamTabInfo[];
  streamFilter: StreamFilter;
  streamSort: StreamSort;
  streamStates: Map<StreamTabId, StreamState>;
}

export function createEmptyStreamState(): StreamState {
  return {
    logs: [],
    taskGroups: new Map(),
    todos: [],
    queuedFollowUps: [],
    runInstructions: new Map(),
    runUsage: new Map(),
    runFiles: new Map(),
    runMissingOutputs: new Map(),
    activeRunId: null,
    selectedRunId: null,
  };
}

export function createInitialState(): ProgressState {
  return {
    activeStreamId: null,
    streams: [],
    streamFilter: 'all',
    streamSort: 'time',
    streamStates: new Map(),
  };
}

export function getStreamState(
  state: ProgressState,
  streamId: StreamTabId,
): StreamState {
  return state.streamStates.get(streamId) ?? createEmptyStreamState();
}

export function getEffectiveRunId(streamState: StreamState): string | null {
  return streamState.selectedRunId ?? streamState.activeRunId;
}
