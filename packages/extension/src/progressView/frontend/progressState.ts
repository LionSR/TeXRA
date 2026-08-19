/**
 * Module-level reactive state for the Progress view.
 *
 * The signals live here rather than on `ProgressApp` because independent DOM
 * trees observe them: the rail (`<stream-tabs>`), the conversation body
 * (`<stream-conversation>`), and the desktop renderer, which drives the same
 * `appState` without mounting `<progress-app>` at all.
 *
 * Singleton scope: only one Progress view per webview/page. If we ever need
 * multiple independent progress instances on the same page, this file must be
 * promoted to a per-instance store.
 */

import { create } from 'mutative';
import { Signal, select, createTrackedSignalRegistry } from '@shared/signals';
import {
  createStreamState,
  isToolUseState,
  STREAM_STATUS,
  type PermissionPayload,
  type ProgressViewPlacement,
  type InquiryThreadUpdatedEvent,
  type PhaseStage,
  type StreamLifecycleStatus,
  type StreamState,
  type StreamTabId,
  type StreamTabInfo,
  type TaskGroup,
} from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/streams/streamStatus';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';
import { toNewestFirstByTimestamp } from '@utils/core';

import { setsEqual, streamDisplayLabel } from './utils';
import { clearFollowUpInputTransientStateStore } from './followUpInputState';
import {
  createInitialState,
  ensureStreamState,
  EMPTY_STREAM_LOGS,
} from './store';
import {
  EMPTY_LOG_CONTEXT,
  EMPTY_PHASE_STAGE_MAP,
  EMPTY_STREAM_CONTEXT,
  type PhaseStageMap,
  type StreamContextValue,
  type StreamLogContextValue,
} from './streamContexts';
import { getPermissionKey } from './permissionState';

// ---------------------------------------------------------------------------
// Stable empty references — avoid allocating new arrays/maps per read.
// ---------------------------------------------------------------------------

/** Stable empty array for activeTaskGroups$ default (avoids new [] per read). */
const EMPTY_TASK_GROUPS: TaskGroup[] = [];

/** Stable empty array for activeInquiries$ default. */
const EMPTY_INQUIRIES: InquiryThreadUpdatedEvent[] = [];

/** Stable empty map returned when no parent has active children. */
const EMPTY_CHILD_MAP: Map<StreamTabId, StreamTabInfo[]> = new Map();

// ---------------------------------------------------------------------------
// State signals (writable)
// ---------------------------------------------------------------------------

// Reset registry — populated by `trackedSignal` as each signal below is
// declared, so `resetProgressState()` can replay that single list instead of
// a hand-ordered, independently-maintained `.set()` sequence. See
// mainViewState.ts / settingsState.ts for the same pattern.
const { trackedSignal, resetAll: resetTrackedSignals } =
  createTrackedSignalRegistry();

/**
 * Single source of truth: monolithic progress state wrapped in a signal.
 * Mutative's structural sharing ensures unchanged branches keep their
 * reference, so selector computeds auto-skip via Object.is().
 */
export const appState = trackedSignal(() => createInitialState());

/** Where the Progress view currently lives (sidebar / editor). */
export const placement = trackedSignal<ProgressViewPlacement>(() => 'sidebar');

/** Webview width threshold flag — drives compact-tab layout. */
export const narrowLayout = trackedSignal(() => false);

/** Pending approval requests; drives permission UI and tab pulse indicator. */
export const permissions$ = trackedSignal<PermissionPayload[]>(() => []);

/**
 * Progress-view commands the active host's inbound registry declares
 * `unsupported(...)`, sent once with UPDATE_STREAMS (see `unsupportedCommands`
 * in `@shared/utils/dispatcher`). Feeds StreamHeader's capability gating so
 * it never renders a control the active host can't act on. `null` before
 * that first UPDATE_STREAMS arrives — treated as "unsupported" by
 * `isKnownUnsupported` so a control never flashes visible then hidden once
 * the real capability set lands.
 */
export const unsupportedProgressCommands$ =
  trackedSignal<ReadonlySet<string> | null>(() => null);

// ---------------------------------------------------------------------------
// Selector computeds: extract fields, auto-memoized by Object.is.
// ---------------------------------------------------------------------------

export const streamById$ = select(appState, (s) => s.streamById);
export const streamStates$ = select(appState, (s) => s.streamStates);
const streamLogs$ = select(appState, (s) => s.streamLogs);
export const activeStreamId$ = select(appState, (s) => s.activeStreamId);
const pendingStreamSelection$ = select(
  appState,
  (s) => s.pendingStreamSelection,
);
/** Pending selection drives only tab feedback; content uses confirmed state. */
export const displayedActiveStreamId$ = new Signal.Computed(
  () => pendingStreamSelection$.get()?.streamId ?? activeStreamId$.get(),
);
const inquiries$ = select(appState, (s) => s.inquiries);

// ---------------------------------------------------------------------------
// Derived computeds: only re-evaluate when selector inputs propagate.
// ---------------------------------------------------------------------------

export const streams$ = new Signal.Computed(() => [
  ...streamById$.get().values(),
]);

/** Top-level streams: the tab list, with child streams excluded. */
export const topLevelStreams$ = new Signal.Computed(() =>
  streams$.get().filter((stream) => !stream.parentStreamId),
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

// ---------------------------------------------------------------------------
// Polite status announcements for the shell's role="status" region
// ---------------------------------------------------------------------------

/**
 * Announcement noun per permission kind. Mirrors the RequestPanels section
 * titles but lives here because that component module registers custom
 * elements on import — a state leaf module cannot touch it.
 */
const PERMISSION_ANNOUNCEMENT_NOUN: Record<PermissionPayload['kind'], string> =
  {
    [PERMISSION_KIND.TOOL_EDIT]: 'file edit',
    [PERMISSION_KIND.BASH]: 'shell command',
    [PERMISSION_KIND.RETRY]: 'retry',
    [PERMISSION_KIND.PROPOSAL]: 'agent proposal',
    [PERMISSION_KIND.PLAN_APPROVAL]: 'plan approval',
    [PERMISSION_KIND.EXTERNAL_INQUIRY]: 'external inquiry',
    [PERMISSION_KIND.USER_QUESTION]: 'user question',
  };

/** One announcement diff pass: the text plus the memos for the next pass. */
interface StatusAnnouncement {
  readonly text: string;
  readonly permissionKeys: ReadonlySet<string>;
  readonly streamStatuses: ReadonlyMap<StreamTabId, StreamLifecycleStatus>;
}

/**
 * Latest event worth announcing in ProgressApp's stable, visually-hidden
 * `role="status"` region: a newly appeared approval request, else a run that
 * just reached a terminal outcome. Pure over explicit previous-pass memos —
 * the caller (ProgressApp's `Signal.subtle.Watcher` effect) owns the memos
 * and the subscription, so this never hides state inside a lazy computed.
 * Approvals are keyed so re-rendering the same pending request never
 * re-announces it, and carry the originating run's label because the queue
 * spans every stream, not just the visible one; terminal outcomes fire only
 * on an observed transition, never for a stream first seen already-finished
 * (history hydrate and trace replay arrive terminal and would otherwise
 * announce every old run at once). A pending approval wins over a completion
 * in the same pass — it is the one demanding action. '' when nothing new
 * happened gives the live region the text-change edge that repeated
 * identical announcements need.
 */
export function diffStatusAnnouncement(
  previousKeys: ReadonlySet<string>,
  previousStatuses: ReadonlyMap<StreamTabId, StreamLifecycleStatus>,
  permissions: readonly PermissionPayload[],
  streamStates: ReadonlyMap<StreamTabId, StreamState>,
  streamById: ReadonlyMap<StreamTabId, StreamTabInfo>,
): StatusAnnouncement {
  let text = '';

  const permissionKeys = new Set<string>();
  for (const permission of permissions) {
    const key = getPermissionKey(permission);
    permissionKeys.add(key);
    if (previousKeys.has(key)) continue;
    const noun = PERMISSION_ANNOUNCEMENT_NOUN[permission.kind];
    const streamId = permission.data.streamId;
    const label = streamId
      ? streamDisplayLabel(streamById.get(streamId))
      : undefined;
    text = label
      ? `Approval requested: ${noun} — ${label}`
      : `Approval requested: ${noun}`;
  }

  const streamStatuses = new Map<StreamTabId, StreamLifecycleStatus>();
  for (const [streamId, state] of streamStates) {
    const status = state.status;
    streamStatuses.set(streamId, status);
    const previous = previousStatuses.get(streamId);
    if (
      text === '' &&
      previous !== undefined &&
      previous !== status &&
      status !== STREAM_STATUS.READY &&
      isTerminalOutcomePhase(status)
    ) {
      const label = streamDisplayLabel(streamById.get(streamId));
      text = label ? `Run ${status}: ${label}` : `Run ${status}`;
    }
  }

  return { text, permissionKeys, streamStatuses };
}

/**
 * Reset every writable signal to its initial value. Called from
 * `ProgressApp`'s constructor on remount in the same JS context (tests,
 * hot reload). Progress state is singleton-scoped per the file header, so
 * the reset is a per-mount slate, not multi-instance coordination.
 *
 * Order matters: `_prevApprovalIds` must be cleared BEFORE
 * `resetTrackedSignals()` replays `permissions$`'s reset because that setter
 * triggers `pendingApprovalIds$` recomputation, which reads `_prevApprovalIds`
 * for the stable-Set memo — if we clear the cache after, the next read sees a
 * stale prior Set and returns it instead of the empty post-reset value.
 * `_prevPhaseStages` is the same memo over `appState`, so it is cleared
 * before that replay too. The announcement diff memos need no reset: they
 * live on the ProgressApp instance driving `diffStatusAnnouncement`, so a
 * remount starts fresh.
 */
export function resetProgressState(): void {
  _prevApprovalIds = new Set();
  _prevPhaseStages = EMPTY_PHASE_STAGE_MAP;
  clearFollowUpInputTransientStateStore();
  resetTrackedSignals();
}

// ---------------------------------------------------------------------------
// Fine-grained active-stream selectors.
// These return stable Map entry values (via Mutative structural sharing).
// When stream B's state changes, activeStreamState$ still returns stream A's
// state (same reference) → Object.is() passes → no downstream propagation.
// ---------------------------------------------------------------------------

/** Only changes when active stream switches or stream list changes. */
const activeStreamInfo$ = new Signal.Computed(() => {
  const id = activeStreamId$.get();
  return id ? (streamById$.get().get(id) ?? null) : null;
});

/**
 * True when at least one top-level tab exists. Gates the empty-state
 * placeholder — `streamById` also holds child streams, which the tab list
 * never renders on its own.
 */
const hasStreams$ = new Signal.Computed(
  () => topLevelStreams$.get().length > 0,
);

/** True when the backend knows any stream at all, child streams included. */
export const hasAnyStreams$ = new Signal.Computed(
  () => streamById$.get().size > 0,
);

/** Only changes when the ACTIVE stream's state changes, not any stream. */
const activeStreamState$ = new Signal.Computed(() => {
  const info = activeStreamInfo$.get();
  if (!info) return null;
  const existing = streamStates$.get().get(info.name);
  if (existing) return existing;
  // No state and no resolved category yet: the stream is pending.
  return info.agentCategory ? createStreamState(info.agentCategory) : null;
});

/** Only changes when the ACTIVE stream's logs change, not any stream. */
const activeStreamLogs$ = new Signal.Computed(() => {
  const info = activeStreamInfo$.get();
  if (!info) return EMPTY_STREAM_LOGS;
  return streamLogs$.get().get(info.name) ?? EMPTY_STREAM_LOGS;
});

// ---------------------------------------------------------------------------
// Leaf selectors for logContext$.
// These extract the specific fields logContext$ needs from activeStreamState$,
// so logContext$ doesn't depend on the full state. When conversationProgress,
// badges, or status change, activeStreamState$ propagates but these return
// the same refs (Mutative structural sharing) → logContext$ stays cached →
// LogList doesn't re-render.
// ---------------------------------------------------------------------------

const activeTaskGroups$ = new Signal.Computed(
  () => activeStreamState$.get()?.taskGroups ?? EMPTY_TASK_GROUPS,
);

/** Inquiry threads whose latest parent stream is the active stream. */
export const activeInquiries$ = new Signal.Computed(() => {
  const activeStreamId = activeStreamId$.get();
  if (!activeStreamId) return EMPTY_INQUIRIES;
  const threads = toNewestFirstByTimestamp(
    [...inquiries$.get().values()].filter(
      (thread) => thread.parentStreamId === activeStreamId,
    ),
    (thread) => thread.lastActivityIso,
  );
  return threads.length > 0 ? threads : EMPTY_INQUIRIES;
});

function samePhaseStages(left: PhaseStageMap, right: PhaseStageMap): boolean {
  if (left.size !== right.size) return false;
  for (const [streamId, stage] of left) {
    const other = right.get(streamId);
    if (
      other === undefined ||
      other.label !== stage.label ||
      other.index !== stage.index ||
      other.total !== stage.total
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Current phase per stream, for streams that have one. Read by the Background
 * Tasks panel, whose rows are *other* streams — so unlike `activeStreamState$`
 * this deliberately spans every stream, and therefore recomputes on *any*
 * field of *any* stream (`streamStates$` changes identity on every progress
 * tick). Returns a stable Map reference when the phases themselves are
 * unchanged, mirroring `pendingApprovalIds$` above, so a run in flight does
 * not re-render its consumers on unrelated ticks. Values are compared by
 * content, not reference: an unchanged phase arrives as a fresh object each
 * time a metadata patch crosses postMessage.
 */
let _prevPhaseStages: PhaseStageMap = EMPTY_PHASE_STAGE_MAP;
export const phaseStages$ = new Signal.Computed((): PhaseStageMap => {
  const stages = new Map<StreamTabId, PhaseStage>();
  for (const [streamId, state] of streamStates$.get()) {
    const stage = state.stage;
    if (stage?.kind === 'phase') stages.set(streamId, stage);
  }
  if (samePhaseStages(stages, _prevPhaseStages)) return _prevPhaseStages;
  _prevPhaseStages = stages.size > 0 ? stages : EMPTY_PHASE_STAGE_MAP;
  return _prevPhaseStages;
});

const activeIsToolUse$ = new Signal.Computed(() => {
  const state = activeStreamState$.get();
  return state ? isToolUseState(state) : false;
});

/**
 * Session-wide identity projection, read when a tool row is projected so an
 * `executions` call names the subagent it waits on. Retained child streams
 * keep their entry, so a completed subagent stays nameable.
 */
export function subagentExecutionLabels(
  streams: Iterable<StreamTabInfo>,
): ExecutionLabels {
  const labels = new Map<string, string>();
  for (const child of streams) {
    if (
      child.identity?.kind === 'process' ||
      !child.parentStreamId ||
      !child.executionId
    ) {
      continue;
    }
    const label = child.label.trim();
    if (label && label !== child.executionId) {
      labels.set(child.executionId, label);
    }
  }
  return labels;
}

/** Stream context derived from active stream + state. */
export const streamContext$ = new Signal.Computed((): StreamContextValue => {
  const activeStreamInfo = activeStreamInfo$.get();
  const hasStreams = hasStreams$.get();
  const unsupportedCommands = unsupportedProgressCommands$.get();
  if (!activeStreamInfo) {
    return { ...EMPTY_STREAM_CONTEXT, hasStreams, unsupportedCommands };
  }

  return {
    streamInfo: activeStreamInfo,
    streamState: activeStreamState$.get(),
    isToolUse: activeIsToolUse$.get(),
    hasStreams,
    unsupportedCommands,
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
    entries: streamLogs.entries,
    rows: streamLogs.rows,
    updatedRowIndices: streamLogs.updatedRowIndices,
    updatedRowBaseGeneration: streamLogs.updatedRowBaseGeneration,
    rowGeneration: streamLogs.generation,
    taskGroups: activeTaskGroups$.get(),
    isToolUse: activeIsToolUse$.get(),
    hasStreams,
    streamName: activeStreamInfo.name,
    streamStatus: activeStreamState$.get()?.status ?? null,
    // Process agents emit raw stdout/stderr; render them terminal-style
    // (monospace, no timestamps, tight spacing) rather than logger entries.
    terminalMode: activeStreamInfo.identity?.kind === 'process',
  };
});

// ---------------------------------------------------------------------------
// Mutators — module-level helpers for stream-scoped updates, shared by the
// webview and the desktop renderer.
// ---------------------------------------------------------------------------

export function setStreamStateForId(
  streamId: StreamTabId,
  updater: (prev: StreamState) => StreamState,
): void {
  const state = appState.get();
  let current = state.streamStates.get(streamId);
  if (!current) {
    const category = state.streamById.get(streamId)?.agentCategory;
    // A stream whose category is still pending has no state to update yet.
    if (!category) return;
    current = createStreamState(category);
  }
  const updated = updater(current);
  if (updated === current) return;
  appState.set(
    create(state, (draft) => {
      // Backfills streamLogs alongside streamStates
      // when this is the first handler to observe the stream (see
      // `ensureStreamState`'s doc comment for the owned key list).
      ensureStreamState(draft, streamId, current.category);
      draft.streamStates.set(streamId, updated);
    }),
  );
}
