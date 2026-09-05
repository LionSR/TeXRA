/**
 * Module-level reactive state for the Progress view's inbound message sink.
 *
 * The slices in `./slices` fold the host's outbound messages into `appState`
 * through `messageDispatcher`; `ProgressApp` is the one element that feeds
 * it. Nothing renders from here any more: the conversation shell reads the
 * session fold (`SessionView`) and the `Surface`, and this store goes with
 * the dispatcher when that fold takes over the wire.
 *
 * Singleton scope: only one Progress view per webview/page.
 */

import { create } from 'mutative';
import { select, createTrackedSignalRegistry } from '@shared/signals';
import {
  createStreamState,
  type PermissionPayload,
  type ProgressViewPlacement,
  type StreamState,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';

import { clearFollowUpInputTransientStateStore } from './followUpInputState';
import { createInitialState, ensureStreamState } from './store';

// ---------------------------------------------------------------------------
// State signals (writable)
// ---------------------------------------------------------------------------

// Reset registry: populated by `trackedSignal` as each signal below is
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

/** Pending approval requests, as the host last listed them. */
export const permissions$ = trackedSignal<PermissionPayload[]>(() => []);

/**
 * Progress-view commands the active host's inbound registry declares
 * `unsupported(...)`, sent once with UPDATE_STREAMS (see `unsupportedCommands`
 * in `@shared/utils/dispatcher`). `null` before that first UPDATE_STREAMS
 * arrives.
 */
export const unsupportedProgressCommands$ =
  trackedSignal<ReadonlySet<string> | null>(() => null);

const streamById$ = select(appState, (s) => s.streamById);
const streamStates$ = select(appState, (s) => s.streamStates);

/**
 * Reset every writable signal to its initial value. Called from
 * `ProgressApp`'s constructor on remount in the same JS context (tests,
 * hot reload). Progress state is singleton-scoped per the file header, so
 * the reset is a per-mount slate, not multi-instance coordination.
 */
export function resetProgressState(): void {
  clearFollowUpInputTransientStateStore();
  resetTrackedSignals();
}

/**
 * Human-readable labels for subagent executions, keyed by execution id, for
 * the tool-output formatters that name a delegated run. A process child and a
 * top-level run carry no such label; a label equal to the id says nothing.
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

// ---------------------------------------------------------------------------
// Mutators: module-level helpers for stream-scoped updates, shared by the
// slices and the event handlers.
// ---------------------------------------------------------------------------

export function setStreamStateForId(
  streamId: StreamTabId,
  updater: (prev: StreamState) => StreamState,
): void {
  const state = appState.get();
  let current = streamStates$.get().get(streamId);
  if (!current) {
    const category = streamById$.get().get(streamId)?.agentCategory;
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
