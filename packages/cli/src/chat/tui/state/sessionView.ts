/**
 * The TUI's read of the one session state (PRD one-fold-three-renderers,
 * 10.1): `SessionHandle.view` bridged into a Lit signal, so every Ink
 * component reads the fold with `useSignal(sessionView())` and derives
 * nothing the fold already states.
 *
 * Bound once per chat session by `runChat` from the runtime session's
 * `view`; a component rendered before that is a programming error, not a
 * case to paper over with an empty view.
 */
import { signal, type Signal } from '@lit-labs/signals';
import { SubscriptionRef } from 'effect';
import { effectRuntime } from '@platform/processRuntime';
import {
  AgentCategory,
  isEmptyUsage,
  isPlainAgentIdentity,
  STREAM_STATUS,
  sumUsageStats,
  USER_FOLLOW_UP_SUPPORT,
  type StreamPhase,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import { toSignal } from '@shared/signals';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import { isInFlightPhase } from '@shared/streams/streamStatus';
import { formatPhaseStageLabel } from '@shared/streams/streamStatusDisplay';

/** The bound bridge, itself a signal so a computed over the view (the
 *  approval Surface's foreground) re-tracks when a chat session rebinds. */
const bound = signal<
  (Signal.State<SessionView> & { dispose: () => void }) | undefined
>(undefined);

/** Bridge a session's view level into the TUI's signal; returns the unbind. */
export function bindSessionView(
  view: SubscriptionRef.SubscriptionRef<SessionView>,
): () => void {
  bound.get()?.dispose();
  // The one meeting point between Effect and the components (PRD 7.5).
  const bridgedBound = toSignal(
    effectRuntime(),
    SubscriptionRef.changes(view),
    SubscriptionRef.getUnsafe(view),
  );
  bound.set(bridgedBound);
  return () => {
    if (bound.get() !== bridgedBound) return;
    bridgedBound.dispose();
    bound.set(undefined);
  };
}

/** The bound view signal. */
export function sessionView(): Signal.State<SessionView> {
  const current = bound.get();
  if (!current) {
    throw new Error(
      'The session view is not bound: call bindSessionView(session.view) before rendering the TUI.',
    );
  }
  return current;
}

/** The current view, read outside a render (keystroke handlers, commands). */
export function currentView(): SessionView {
  return sessionView().get();
}

export function streamViewOf(
  view: SessionView,
  streamId: StreamTabId | undefined,
): StreamView | undefined {
  return streamId === undefined ? undefined : view.streams.get(streamId);
}

/**
 * The Surface's selection resolved against the view at read (PRD 9): the
 * selected stream while the view holds it; the first top-level stream once
 * it has left; the selection itself while the view holds no stream at all
 * (the pre-run local conversation is a Surface-only id). No effect watches
 * the view to clear a stale selection.
 */
export function selectedStreamId(
  view: SessionView,
  selected: StreamTabId | undefined,
): StreamTabId | undefined {
  if (selected === undefined || view.streams.has(selected)) return selected;
  return view.streams.size === 0 ? selected : view.order.at(0);
}

/** Whether a focused child stream takes the composer's follow-ups (PRD 10.1). */
export function focusedChildAcceptsFollowUps(stream: StreamView): boolean {
  return (
    stream.followUpSupport === USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE &&
    isPlainAgentIdentity(stream.identity) &&
    stream.category === AgentCategory.ToolUse &&
    isInFlightPhase(stream.status)
  );
}

/**
 * The focus tree of one root: the root, then its children newest first, so
 * Alt+1 names the newest child (the Surface's Alt-index rule, PRD 9). A
 * grandchild is reached through its own parent's list.
 */
export function focusTreeOf(
  view: SessionView,
  rootStreamId: StreamTabId | undefined,
): readonly StreamTabId[] {
  const root = streamViewOf(view, rootStreamId);
  if (!root) return [];
  return [root.id, ...root.childIds.toReversed()];
}

/** The stream's phase: undefined before the first `status` folds. */
export function streamPhaseOf(
  stream: StreamView | undefined,
): StreamPhase | undefined {
  return stream === undefined || stream.status === STREAM_STATUS.READY
    ? undefined
    : stream.status;
}

/** Every stream under `rootStreamId`, the root included, parents first. */
export function descendantStreamIds(
  view: SessionView,
  rootStreamId: StreamTabId | undefined,
): readonly StreamTabId[] {
  const out: StreamTabId[] = [];
  const pending = rootStreamId === undefined ? [] : [rootStreamId];
  const seen = new Set<StreamTabId>();
  while (pending.length > 0) {
    const id = pending.shift()!;
    const stream = view.streams.get(id);
    if (!stream || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    pending.push(...stream.childIds);
  }
  return out;
}

/**
 * The direct children in the RUNNING phase. The fold's `rollup.running`
 * counts in-flight streams (running or idle-waiting); the TUI's "active"
 * excludes a child parked between turns, so it reads each child's status
 * fact rather than the rollup.
 */
export function runningChildCount(
  view: SessionView,
  stream: StreamView | undefined,
): number {
  return (stream?.childIds ?? []).filter(
    (id) => view.streams.get(id)?.status === STREAM_STATUS.RUNNING,
  ).length;
}

/** Whether the root or any stream under it is in the RUNNING phase. */
export function anyStreamRunning(
  view: SessionView,
  rootStreamId: StreamTabId | undefined,
): boolean {
  return descendantStreamIds(view, rootStreamId).some(
    (id) => view.streams.get(id)?.status === STREAM_STATUS.RUNNING,
  );
}

/** The run's usage across its executions; undefined when nothing was metered. */
export function cumulativeUsageOf(
  stream: StreamView | undefined,
): TokenUsageStats | undefined {
  if (!stream) return undefined;
  const total = sumUsageStats(Object.values(stream.usage));
  return isEmptyUsage(total) ? undefined : total;
}

/** The nearest ancestor's workflow-phase heading, for a child's location. */
export function ancestorPhaseLabel(
  view: SessionView,
  streamId: StreamTabId,
): string | undefined {
  const ancestors = streamViewOf(view, streamId)?.ancestors ?? [];
  // Root first in the view; the nearest ancestor's phase wins.
  for (const ancestor of ancestors.toReversed()) {
    const stage = streamViewOf(view, ancestor.id)?.stage;
    if (stage?.kind === 'phase') return formatPhaseStageLabel(stage);
  }
  return undefined;
}
