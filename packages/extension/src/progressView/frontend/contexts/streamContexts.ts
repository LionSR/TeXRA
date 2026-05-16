/**
 * Lit context definitions for ProgressView.
 *
 * Context values use types from the store and shared schemas.
 */

// Third-party imports
import { createContext } from '@lit/context';

// Local imports - progress view
import type {
  LogMessageData,
  InquiryThreadUpdatedEvent,
  StreamStatus,
  StreamTabId,
  StreamTabInfo,
  TaskGroup,
} from '@shared/schemas';
import type { FollowupOptionsState, StreamState } from '../store';

// Local imports - progress view components
import type { PermissionState } from '../components/PermissionCard';

/** Context value for stream state, providing all data needed by stream content components. */
export interface StreamContextValue {
  streamInfo: StreamTabInfo | null;
  streamState: StreamState | null;
  /** Pre-computed stream type flag - true for tool-use, false for workflow */
  isToolUse: boolean;
  /** Whether there are any streams in the current filter (for placeholder logic) */
  hasStreams: boolean;
  /** Tool-use follow-up options for completed workflow streams. */
  followupOptions: FollowupOptionsState | null;
}

/** Default empty stream context value. */
export const EMPTY_STREAM_CONTEXT: StreamContextValue = {
  streamInfo: null,
  streamState: null,
  isToolUse: false,
  hasStreams: false,
  followupOptions: null,
};

export const streamStateContext = createContext<StreamContextValue>(
  'progress-stream-state',
);

/**
 * Separate context for log data — changes on every streaming update.
 * Only consumed by LogList, so content components avoid re-rendering during streaming.
 */
export interface StreamLogContextValue {
  logs: LogMessageData[];
  /** Existing log-message indices updated by the most recent backend delta. */
  updatedMessageIndices: readonly number[];
  /** Generation immediately before `updatedMessageIndices` was collected. */
  updatedMessageBaseGeneration: number;
  /** Current log generation. */
  messageGeneration: number;
  taskGroups: TaskGroup[];
  isToolUse: boolean;
  hasStreams: boolean;
  /** Stream name for switch detection in LogList */
  streamName: string | null;
  /** Current active stream status for pre-output empty states. */
  streamStatus: StreamStatus | null;
  /** Render log output in terminal style (monospace, no timestamps, etc). */
  terminalMode: boolean;
}

export const EMPTY_LOG_CONTEXT: StreamLogContextValue = {
  logs: [],
  updatedMessageIndices: [],
  updatedMessageBaseGeneration: 0,
  messageGeneration: 0,
  taskGroups: [],
  isToolUse: false,
  hasStreams: false,
  streamName: null,
  streamStatus: null,
  terminalMode: false,
};

export const streamLogContext = createContext<StreamLogContextValue>(
  'progress-stream-log',
);

export const permissionsContext = createContext<PermissionState[]>(
  'progress-permissions',
);

/**
 * Separate context for background process outputs — changes on every output chunk.
 * Only consumed by BackgroundTasksPanel, avoiding re-renders of other components.
 * Keyed by executionId → accumulated stdout/stderr.
 */
export interface ProcessOutputEntry {
  stdout: string;
  stderr: string;
}

export type ProcessOutputMap = Map<string, ProcessOutputEntry>;

export const EMPTY_PROCESS_OUTPUTS: ProcessOutputMap = new Map();

export const processOutputContext = createContext<ProcessOutputMap>(
  'progress-process-outputs',
);

export const EMPTY_INQUIRY_THREADS: InquiryThreadUpdatedEvent[] = [];

export const inquiryThreadsContext = createContext<InquiryThreadUpdatedEvent[]>(
  'progress-inquiry-threads',
);

/**
 * streamById context: Map<streamId, StreamTabInfo>. Single source of truth
 * for per-stream metadata including AI-generated descriptions.
 * Consumed by BackgroundTasksPanel to label subagent entries.
 */
export type StreamByIdMap = ReadonlyMap<StreamTabId, StreamTabInfo>;

export const EMPTY_STREAM_BY_ID: StreamByIdMap = new Map();

export const streamByIdContext = createContext<StreamByIdMap>(
  'progress-stream-by-id',
);
