/**
 * Module-level reactive state for the Progress view.
 *
 * Hoisted from `ProgressApp` private fields (PRD: docs/prd/electron-shell-layout.md § 7.A).
 * Both the rail (`<stream-tabs>`) and the conversation body need to observe the
 * same signals from independent DOM trees once PR 2 extracts `<stream-conversation>`.
 *
 * No behavior change: every signal here was previously a private field on the
 * `ProgressApp` class. Identity and reactivity are preserved — selectors are
 * still `select()` / `Signal.Computed`, so consumers do not need to re-subscribe.
 *
 * Singleton scope: only one Progress view per webview/page. If we ever need
 * multiple independent progress instances on the same page, this file must be
 * promoted to a per-instance store.
 */

import { create } from 'mutative';
import { Signal, signal, select, combine } from '@shared/signals';
import {
  createStreamState,
  type ProgressViewPlacement,
  type StreamTabId,
  type StreamTabInfo,
  type TaskGroup,
} from '@shared/schemas';
import { isProcessAgent } from '@shared/streams/agentKind';

import { setsEqual } from './utils';
import {
  createInitialState,
  EMPTY_STREAM_LOGS,
  getStreamState,
  isToolUseState,
  type StreamLogs,
  type StreamState,
} from './store';
import {
  EMPTY_LOG_CONTEXT,
  EMPTY_PROCESS_OUTPUTS,
  EMPTY_STREAM_CONTEXT,
  type ProcessOutputMap,
  type StreamContextValue,
  type StreamLogContextValue,
} from './contexts/streamContexts';
import type { PermissionState } from './components/PermissionCard';

// ---------------------------------------------------------------------------
// Stable empty references — avoid allocating new arrays/maps per read.
// ---------------------------------------------------------------------------

/** Stable empty array for activeTaskGroups$ default (avoids new [] per read). */
const EMPTY_TASK_GROUPS: TaskGroup[] = [];

/** Stable empty map returned when no parent has active children. */
const EMPTY_CHILD_MAP: Map<StreamTabId, StreamTabInfo[]> = new Map();

// ---------------------------------------------------------------------------
// State signals (writable)
// ---------------------------------------------------------------------------

/**
 * Single source of truth: monolithic progress state wrapped in a signal.
 * Mutative's structural sharing ensures unchanged branches keep their
 * reference, so selector computeds auto-skip via Object.is().
 */
export const appState = signal(createInitialState());

/** Where the Progress view currently lives (sidebar / editor). */
export const placement = signal<ProgressViewPlacement>('sidebar');

/** Webview width threshold flag — drives compact-tab layout. */
export const narrowLayout = signal(false);

/** Pending approval requests; drives permission UI and tab pulse indicator. */
export const permissions$ = signal<PermissionState[]>([]);

// ---------------------------------------------------------------------------
// Selector computeds: extract fields, auto-memoized by Object.is.
// ---------------------------------------------------------------------------

export const streamById$ = select(appState, (s) => s.streamById);
export const streamFilter$ = select(appState, (s) => s.streamFilter);
export const streamStates$ = select(appState, (s) => s.streamStates);
export const streamLogs$ = select(appState, (s) => s.streamLogs);
export const activeStreamId$ = select(appState, (s) => s.activeStreamId);
export const processOutputs$ = select(appState, (s) => s.processOutputs);
export const followupOptions$ = select(
  appState,
  (s) => s.followupOptionsByStream,
);

// ---------------------------------------------------------------------------
// Derived computeds: only re-evaluate when selector inputs propagate.
// ---------------------------------------------------------------------------

export const streams$ = new Signal.Computed(() => [
  ...streamById$.get().values(),
]);

/** Top-level streams for the tab list (child streams excluded). */
export const tabStreams$ = combine(
  [streams$, streamFilter$] as const,
  (streams, filter) => {
    const topLevel = streams.filter((s) => !s.parentStreamId);
    if (filter === 'all') return topLevel;
    return topLevel.filter((s) => s.agentCategory === filter);
  },
);

/**
 * Child streams grouped by parent stream ID.
 * Depends only on streamById$ (stream registry), NOT streamStates$,
 * so it only recomputes when streams are added/removed — not on
 * every status or timestamp update.
 */
export const childStreamsByParent$ = new Signal.Computed(() => {
  const grouped = new Map<StreamTabId, StreamTabInfo[]>();
  for (const stream of streamById$.get().values()) {
    if (!stream.parentStreamId) continue;
    const siblings = grouped.get(stream.parentStreamId);
    if (siblings) {
      siblings.push(stream);
    } else {
      grouped.set(stream.parentStreamId, [stream]);
    }
  }
  return grouped.size > 0 ? grouped : EMPTY_CHILD_MAP;
});

/**
 * Stream IDs with pending approval requests — drives tab pulse indicator.
 * Returns a stable Set reference when contents are unchanged so downstream
 * `Signal.Computed` consumers can skip propagation via Object.is().
 */
let _prevApprovalIds: Set<string> = new Set();
export const pendingApprovalIds$ = new Signal.Computed(() => {
  const ids = new Set<string>();
  for (const p of permissions$.get()) {
    const streamId = p.data.streamId;
    if (streamId) ids.add(streamId);
  }
  if (setsEqual(ids, _prevApprovalIds)) {
    return _prevApprovalIds;
  }
  _prevApprovalIds = ids;
  return ids;
});

/**
 * Reset every writable signal to its initial value. Called from
 * `ProgressApp`'s constructor on remount in the same JS context (tests,
 * hot reload). Progress state is singleton-scoped per the file header, so
 * the reset is a per-mount slate, not multi-instance coordination.
 *
 * Order matters: `_prevApprovalIds` must be cleared BEFORE
 * `permissions$.set([])` because that setter triggers `pendingApprovalIds$`
 * recomputation, which reads `_prevApprovalIds` for the stable-Set memo —
 * if we clear the cache after, the next read sees a stale prior Set and
 * returns it instead of the empty post-reset value.
 */
export function resetProgressState(): void {
  _prevApprovalIds = new Set();
  appState.set(createInitialState());
  placement.set('sidebar');
  narrowLayout.set(false);
  permissions$.set([]);
}

// ---------------------------------------------------------------------------
// Fine-grained active-stream selectors.
// These return stable Map entry values (via Mutative structural sharing).
// When stream B's state changes, activeStreamState$ still returns stream A's
// state (same reference) → Object.is() passes → no downstream propagation.
// ---------------------------------------------------------------------------

/** Only changes when active stream switches or stream list changes. */
export const activeStreamInfo$ = new Signal.Computed(() => {
  const id = activeStreamId$.get();
  return id ? (streamById$.get().get(id) ?? null) : null;
});

/**
 * True when the current filter yields at least one tab. Gates the
 * "no streams match" placeholder — backend now sends every stream
 * unfiltered, so `streamById.size` alone can't distinguish "nothing
 * visible" from "everything hidden by filter".
 */
export const hasStreams$ = new Signal.Computed(
  () => tabStreams$.get().length > 0,
);

/** True only when the backend knows no streams at all, independent of filter. */
export const hasAnyStreams$ = new Signal.Computed(
  () => streamById$.get().size > 0,
);

/** Only changes when the ACTIVE stream's state changes, not any stream. */
export const activeStreamState$ = new Signal.Computed(() => {
  const info = activeStreamInfo$.get();
  if (!info) return null;
  return (
    streamStates$.get().get(info.name) ?? createStreamState(info.agentCategory)
  );
});

/** Only changes when the ACTIVE stream's logs change, not any stream. */
export const activeStreamLogs$ = new Signal.Computed(() => {
  const info = activeStreamInfo$.get();
  if (!info) return EMPTY_STREAM_LOGS;
  return streamLogs$.get().get(info.name) ?? EMPTY_STREAM_LOGS;
});

/** Only changes when the ACTIVE stream's process outputs change. */
export const activeProcessOutputs$ = new Signal.Computed(
  (): ProcessOutputMap => {
    const info = activeStreamInfo$.get();
    if (!info) return EMPTY_PROCESS_OUTPUTS;
    return processOutputs$.get().get(info.name) ?? EMPTY_PROCESS_OUTPUTS;
  },
);

// ---------------------------------------------------------------------------
// Leaf selectors for logContext$.
// These extract the specific fields logContext$ needs from activeStreamState$,
// so logContext$ doesn't depend on the full state. When conversationProgress,
// badges, or status change, activeStreamState$ propagates but these return
// the same refs (Mutative structural sharing) → logContext$ stays cached →
// LogList doesn't re-render.
// ---------------------------------------------------------------------------

export const activeTaskGroups$ = new Signal.Computed(
  () => activeStreamState$.get()?.taskGroups ?? EMPTY_TASK_GROUPS,
);

export const activeIsToolUse$ = new Signal.Computed(() => {
  const state = activeStreamState$.get();
  return state ? isToolUseState(state) : false;
});

/** Stream context derived from active stream + state. */
export const streamContext$ = new Signal.Computed((): StreamContextValue => {
  const activeStreamInfo = activeStreamInfo$.get();
  const hasStreams = hasStreams$.get();
  if (!activeStreamInfo) return { ...EMPTY_STREAM_CONTEXT, hasStreams };

  const streamState = activeStreamState$.get();
  const isToolUse = streamState ? isToolUseState(streamState) : false;
  const followupOptions =
    followupOptions$.get().get(activeStreamInfo.name) ?? null;
  return {
    streamInfo: activeStreamInfo,
    streamState,
    isToolUse,
    hasStreams,
    followupOptions,
  };
});

/**
 * Log context derived from active stream + logs.
 * Depends on leaf selectors so status/badge/progress changes
 * don't cause LogList re-renders.
 */
export const logContext$ = new Signal.Computed((): StreamLogContextValue => {
  const activeStreamInfo = activeStreamInfo$.get();
  const hasStreams = hasStreams$.get();
  if (!activeStreamInfo) return { ...EMPTY_LOG_CONTEXT, hasStreams };
  const streamLogs = activeStreamLogs$.get();

  return {
    logs: streamLogs.logs,
    updatedMessageIndices: streamLogs.updatedMessageIndices,
    updatedMessageBaseGeneration: streamLogs.updatedMessageBaseGeneration,
    messageGeneration: streamLogs.generation,
    taskGroups: activeTaskGroups$.get(),
    isToolUse: activeIsToolUse$.get(),
    hasStreams,
    streamName: activeStreamInfo.name,
    streamStatus: activeStreamState$.get()?.status ?? null,
    // Process agents emit raw stdout/stderr; render them terminal-style
    // (monospace, no timestamps, tight spacing) rather than logger entries.
    terminalMode: isProcessAgent(activeStreamInfo.agent),
  };
});

// ---------------------------------------------------------------------------
// Mutators — module-level helpers for stream-scoped updates.
//
// Hoisted from `ProgressApp` private methods (PRD: docs/prd/electron-shell-layout.md
// § 7.A) so the desktop renderer can drive the same `appState` updates without
// mounting `<progress-app>`. Behavior preserved exactly: same fast-path,
// same skip-no-op short-circuit, same Mutative structural sharing.
// ---------------------------------------------------------------------------

export function setStreamStateForId(
  streamId: StreamTabId,
  updater: (prev: StreamState) => StreamState,
): void {
  const state = appState.get();
  let current = state.streamStates.get(streamId);
  if (!current) {
    const streamInfo = state.streamById.get(streamId);
    if (!streamInfo) return;
    current = getStreamState(state, streamId, streamInfo.agentCategory);
  }
  const updated = updater(current);
  if (updated === current) return;
  appState.set(
    create(state, (draft) => {
      draft.streamStates.set(streamId, updated);
    }),
  );
}

export function setStreamLogsForId(
  streamId: StreamTabId,
  updater: (prev: StreamLogs) => StreamLogs,
): void {
  const state = appState.get();
  if (!state.streamStates.has(streamId)) return;
  const current = state.streamLogs.get(streamId) ?? EMPTY_STREAM_LOGS;
  const updated = updater(current);
  if (updated === current) return;
  appState.set(
    create(state, (draft) => {
      draft.streamLogs.set(streamId, updated);
    }),
  );
}
