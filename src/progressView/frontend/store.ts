// Local imports
import type {
  ContextState,
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
export type FollowupMode = 'chat' | 'workflow' | 'merge';

export type { ContextState };

export interface StreamState {
  info?: StreamTabInfo;
  status?: StreamStatus;
  logs: LogMessageData[];
  taskGroups: TaskGroup[];
  todos: TodoItem[];
  queuedFollowUps: string[];
  runInstructions: Record<string, InstructionUpdate>;
  runUsage: Record<string, TokenUsageStats>;
  runFiles: Record<string, Record<string, OutputFileInfo[]>>;
  runMissingOutputs: Record<string, Record<string, string[]>>;
  activeRunId: string | null;
  selectedRunId: string | null;
  contextState?: ContextState;
  toolEditBypass?: boolean;
  followUpText?: string;
  followupMode?: FollowupMode;
}

export interface ProgressState {
  activeStreamId: StreamTabId | null;
  streams: StreamTabInfo[];
  streamFilter: StreamFilter;
  streamSort: StreamSort;
  streamStates: Map<StreamTabId, StreamState>;
  followupOptions: {
    workflowAgentsHtml: string;
    toolUseAgentsHtml: string;
    modelOptionsHtml: string;
    defaultMergeModel?: string;
  } | null;
}

export function createEmptyStreamState(): StreamState {
  return {
    logs: [],
    taskGroups: [],
    todos: [],
    queuedFollowUps: [],
    runInstructions: {},
    runUsage: {},
    runFiles: {},
    runMissingOutputs: {},
    activeRunId: null,
    selectedRunId: null,
    followUpText: '',
    followupMode: 'chat',
  };
}

export function createInitialState(): ProgressState {
  return {
    activeStreamId: null,
    streams: [],
    streamFilter: 'all',
    streamSort: 'time',
    streamStates: new Map(),
    followupOptions: null,
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
