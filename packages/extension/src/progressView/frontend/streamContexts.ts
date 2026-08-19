/**
 * Lit context definitions for ProgressView.
 *
 * Context values use types from the store and shared schemas.
 */

// Third-party imports
import { createContext } from '@lit/context';

// Local imports - progress view
import type {
  InquiryThreadUpdatedEvent,
  PhaseStage,
  StreamLifecycleStatus,
  StreamLogEntry,
  StreamState,
  StreamTabId,
  StreamTabInfo,
  TaskGroup,
} from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';

// Local imports - progress view components
import type { PermissionState } from './permissionState';

/** Context value for stream state, providing all data needed by stream content components. */
export interface StreamContextValue {
  streamInfo: StreamTabInfo | null;
  streamState: StreamState | null;
  /** Pre-computed stream type flag - true for tool-use, false for workflow */
  isToolUse: boolean;
  /** Whether there are any streams in the current filter (for placeholder logic) */
  hasStreams: boolean;
  /**
   * Progress-view commands the active host's inbound registry declares
   * `unsupported(...)` (see `unsupportedCommands` in `@shared/utils/dispatcher`).
   * StreamHeader derives its button visibility from this instead of an
   * `isDesktopHost` check. `null` before the host's one-shot capability
   * broadcast arrives; pair with `isKnownUnsupported` (also in
   * `@shared/utils/dispatcher`) rather than reading it directly.
   */
  unsupportedCommands: ReadonlySet<string> | null;
}

/** Default empty stream context value. */
export const EMPTY_STREAM_CONTEXT: StreamContextValue = {
  streamInfo: null,
  streamState: null,
  isToolUse: false,
  hasStreams: false,
  unsupportedCommands: null,
};

export const streamStateContext = createContext<StreamContextValue>(
  'progress-stream-state',
);

/**
 * Separate context for log data — changes on every streaming update.
 * Only consumed by LogList, so content components avoid re-rendering during streaming.
 */
export interface StreamLogContextValue {
  /** Source entries, rendered raw by a process stream's terminal view. */
  entries: StreamLogEntry[];
  rows: TranscriptRow[];
  /** Existing row indices updated by the most recent backend delta. */
  updatedRowIndices: readonly number[];
  /** Generation immediately before `updatedRowIndices` was collected. */
  updatedRowBaseGeneration: number;
  /** Current log generation. */
  rowGeneration: number;
  taskGroups: TaskGroup[];
  isToolUse: boolean;
  hasStreams: boolean;
  /** Stream name for switch detection in LogList */
  streamName: string | null;
  /** Current active stream status for pre-output empty states. */
  streamStatus: StreamLifecycleStatus | null;
  /** Render log output in terminal style (monospace, no timestamps, etc). */
  terminalMode: boolean;
}

export const EMPTY_LOG_CONTEXT: StreamLogContextValue = {
  entries: [],
  rows: [],
  updatedRowIndices: [],
  updatedRowBaseGeneration: 0,
  rowGeneration: 0,
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

/**
 * phaseStages context: Map<streamId, PhaseStage> for the streams currently in
 * a workflow-script phase. Consumed by BackgroundTasksPanel, whose rows are
 * *other* streams than the active one — `streamStateContext` only carries the
 * active stream's state, so a child run's phase cannot be read from there.
 */
export type PhaseStageMap = ReadonlyMap<StreamTabId, PhaseStage>;

export const EMPTY_PHASE_STAGE_MAP: PhaseStageMap = new Map();

export const phaseStagesContext = createContext<PhaseStageMap>(
  'progress-phase-stages',
);

/**
 * Durable delivery boundary for follow-up events. The conversation element
 * outlives whichever stream-specific input is currently rendered, so async
 * paste work can still reach host handlers after that input disconnects.
 */
export type FollowUpEventSink = (event: CustomEvent) => void;

export const followUpEventSinkContext = createContext<FollowUpEventSink>(
  'progress-follow-up-event-sink',
);

/**
 * Whether request panels render in a read-only, archived mode — true for a
 * static trace-viewer export (`packages/trace-viewer/`) replaying a finished
 * run with no live backend to send actions to. Defaults to `false` for every
 * live host (VS Code extension, desktop, webview). Consumed by
 * `BaseRequestPanel`/`BaseFeedbackPanel` to disable action buttons instead of
 * leaving live dead-clicks that dispatch a `permission-action` event nothing
 * answers. Named `archived` (not `readonly`) to avoid reading like the TS
 * `readonly` modifier keyword at call sites.
 */
export const archivedContext = createContext<boolean>('progress-archived');

/**
 * The settable shape of `<stream-conversation>`'s `archived` property, for
 * hosts (like the trace-viewer) that set it on a freshly created element
 * before providing it via `archivedContext`. Naming this explicitly makes the
 * coupling grep-able instead of an inline structural cast.
 */
export interface ArchivableElement extends HTMLElement {
  archived: boolean;
}
