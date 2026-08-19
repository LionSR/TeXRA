// Reactive CLI view over the shared session substrate's child-stream state.
//
// The shared `SessionFactApplier` → `SessionState` pair (attached in
// `sessionSignalsAdapter.ts`) owns the child rosters (live rows plus finished
// rows retained for display, phase-merged, 200-capped), the parent edges
// (`getStreamMetadata(id).parentStreamId`), and the removal tombstones
// (`isStreamRemoved`). This module holds no state of its own: it binds the
// adapter's `SessionState` and re-derives signal snapshots whenever the
// adapter reports a change, so Ink components re-render off one source of
// truth instead of a parallel fact-fold. (Collapsed from the former 692-line
// `CHILD_STREAMS` state machine — single-substrate plan, Wave A.)

import { computed, signal, type Signal } from '@lit-labs/signals';
import type {
  SessionState,
  SessionStreamMetadata,
  StreamExecutionState,
} from '@controllers/session/SessionState';
import {
  runIdentityDisplayName,
  type ActiveChildInfo,
  type StreamTabId,
} from '@shared/schemas';

import type { StreamSlice } from './cliState';

interface BoundChildStreamState {
  readonly state: SessionState;
  readonly revision: number;
}

const BOUND = signal<BoundChildStreamState | undefined>(undefined);

/** Bind the adapter-owned `SessionState` as the child-stream authority. */
export function bindChildStreamState(state: SessionState): void {
  BOUND.set({ state, revision: 0 });
}

/** Drop the binding when the adapter detaches. */
export function unbindChildStreamState(state: SessionState): void {
  if (BOUND.get()?.state === state) BOUND.set(undefined);
}

/**
 * Re-derive the child-stream snapshots from the bound `SessionState`. Called
 * by the adapter after any change that can move rosters, parent edges, or
 * tombstones: `onBadgesChanged`, `invalidate(…, 'parentStreamId')`,
 * `onStreamMetadataChanged` (a new RUNNING drops the previous run's retained
 * rows and surfaces only here), and the adapter's `deleteStream` removal hook
 * (removal fires no renderer-port callback by design).
 */
export function invalidateChildStreams(): void {
  const bound = BOUND.get();
  if (bound) BOUND.set({ state: bound.state, revision: bound.revision + 1 });
}

/**
 * Revision counter over the bound `SessionState`. A component whose render
 * reads the shared state through `streamMetadataFor`/`streamStateFor`/
 * `queuedFollowUpsFor` must `useSignal(sessionStateRevision)` (point-in-time
 * readers — command handlers, teardown paths — read the helpers plainly).
 */
export const sessionStateRevision: Signal.Computed<number> = computed(
  () => BOUND.get()?.revision ?? 0,
);

/** Shared metadata record for a stream: identity, follow-up support, agent
 *  category, config (model/instruction/cwd), description, parent edge. */
export function streamMetadataFor(
  streamId: StreamTabId,
): Readonly<SessionStreamMetadata> | undefined {
  return BOUND.get()?.state.getStreamMetadata(streamId);
}

/** Shared per-run execution counters for a stream: category, conversation
 *  progress, stage, subagent roster. */
export function streamStateFor(
  streamId: StreamTabId,
): StreamExecutionState | undefined {
  return BOUND.get()?.state.getStreamState(streamId);
}

/** Queued follow-up messages for a stream, from the session-owned queue. */
export function queuedFollowUpsFor(streamId: StreamTabId): readonly string[] {
  return BOUND.get()?.state.followUps.getAll(streamId) ?? [];
}

/** Per-parent merged child roster: live rows first (emission order), then
 *  finished rows retained for display, ascending `finishedAt` — the shared
 *  applier's order, rendered verbatim by every host. */
export type ChildRosters = ReadonlyMap<StreamTabId, readonly ActiveChildInfo[]>;

function boundStreamIds(state: SessionState): readonly StreamTabId[] {
  return state.streamLogs.keys();
}

/**
 * Snapshot of every parent's child roster. Fresh map per invalidation —
 * consumers that gate expensive work compare content, not reference.
 */
export const childRosters: Signal.Computed<ChildRosters> = computed(() => {
  const bound = BOUND.get();
  if (!bound) return new Map();
  const out = new Map<StreamTabId, readonly ActiveChildInfo[]>();
  for (const streamId of boundStreamIds(bound.state)) {
    if (bound.state.isStreamRemoved(streamId)) continue;
    const roster = bound.state.getStreamState(streamId)?.subagents;
    if (roster && roster.length > 0) out.set(streamId, roster);
  }
  return out;
});

/**
 * Derived child → current-parent topology from the shared metadata authority.
 * A tombstoned child or parent contributes no edge, so a late fact cannot
 * re-attach a stream to a removed ancestor.
 */
export const parentStream: Signal.Computed<
  ReadonlyMap<StreamTabId, StreamTabId>
> = computed(() => {
  const bound = BOUND.get();
  if (!bound) return new Map();
  const out = new Map<StreamTabId, StreamTabId>();
  for (const streamId of boundStreamIds(bound.state)) {
    if (bound.state.isStreamRemoved(streamId)) continue;
    const parent = bound.state.getStreamMetadata(streamId).parentStreamId;
    if (parent && !bound.state.isStreamRemoved(parent)) {
      out.set(streamId, parent);
    }
  }
  return out;
});

/** Retained execution-id → human label projection for executions tool rows.
 *  Contract: only labels that differ from the raw execution id are present. */
export const subagentExecutionLabels: Signal.Computed<
  ReadonlyMap<string, string>
> = computed(() => {
  const labels = new Map<string, string>();
  for (const roster of childRosters.get().values()) {
    for (const child of roster) {
      const label = childExecutionLabel(child);
      if (label !== child.executionId) labels.set(child.executionId, label);
    }
  }
  return labels;
});

/**
 * The same label projection, sampled synchronously — what the transcript fold
 * reads at projection time. Reading the roster snapshot here (rather than the
 * fold reaching the signal) keeps the fold free of the reactive graph: it
 * re-runs per appended/dirtied entry, never per label invalidation, and a row
 * re-projected on its own result-settle picks up whatever label has landed by
 * then. Rows folded while a child is still launching carry the raw id until
 * that settle — the one bounded window the projection-time read leaves open.
 */
export function subagentExecutionLabelsNow(): ReadonlyMap<string, string> {
  const bound = BOUND.get();
  if (!bound) return new Map();
  const labels = new Map<string, string>();
  for (const streamId of boundStreamIds(bound.state)) {
    if (bound.state.isStreamRemoved(streamId)) continue;
    const roster = bound.state.getStreamState(streamId)?.subagents;
    if (!roster) continue;
    for (const child of roster) {
      const label = childExecutionLabel(child);
      if (label !== child.executionId) labels.set(child.executionId, label);
    }
  }
  return labels;
}

/** Whether a stream identity carries the session's removal tombstone. */
export function isChildStreamRemoved(streamId: StreamTabId): boolean {
  return BOUND.get()?.state.isStreamRemoved(streamId) ?? false;
}

// ---------------------------------------------------------------------------
// selectors (pure over a `ChildRosters` snapshot)
// ---------------------------------------------------------------------------

/**
 * Active subagent roster for a parent: the shared roster's live rows
 * (`finishedAt` unset — the schema contract for active membership). Rows are
 * already phase-merged and tombstone-filtered by the applier at write time.
 * This selector, not status, decides killability.
 */
export function activeSubagentsFor(
  parentStreamId: StreamTabId,
  rosters: ChildRosters,
): readonly ActiveChildInfo[] {
  const roster = rosters.get(parentStreamId);
  if (!roster) return [];
  return roster.filter((child) => child.finishedAt === undefined);
}

/**
 * Finished children the shared roster retains for display under a parent
 * (`finishedAt` set), ascending `finishedAt`, capped by the applier. A new
 * run on the parent drops the previous run's retained rows (shared
 * `resetPerRunChildState` policy — all hosts agree).
 */
export function retainedChildStreamsFor(
  parentStreamId: StreamTabId,
  rosters: ChildRosters,
): readonly ActiveChildInfo[] {
  const roster = rosters.get(parentStreamId);
  if (!roster) return [];
  return roster.filter((child) => child.finishedAt !== undefined);
}

/** Display rows for a parent: the shared roster verbatim (live rows first,
 *  then retained history) — the same order the webview renders. */
export function visibleSubagentRows(
  parentStreamId: StreamTabId,
  rosters: ChildRosters,
): readonly ActiveChildInfo[] {
  return rosters.get(parentStreamId) ?? [];
}

/**
 * Focus-cycle order for a parent's descendants: roster rows first (shared
 * order), then current-topology children not in the roster (edge observed
 * before any roster tick). A child `StreamSlice` must exist before it is
 * focusable.
 */
export function focusOrderDescendants(
  parentStreamId: StreamTabId,
  rosters: ChildRosters,
  parentEdges: ReadonlyMap<StreamTabId, StreamTabId>,
  streams: ReadonlyMap<StreamTabId, StreamSlice>,
): readonly StreamTabId[] {
  const out: StreamTabId[] = [];
  const seen = new Set<StreamTabId>();
  for (const child of rosters.get(parentStreamId) ?? []) {
    if (!streams.has(child.childStreamId) || seen.has(child.childStreamId)) {
      continue;
    }
    seen.add(child.childStreamId);
    out.push(child.childStreamId);
  }
  for (const [childStreamId, parent] of parentEdges) {
    if (parent !== parentStreamId || seen.has(childStreamId)) continue;
    if (!streams.has(childStreamId)) continue;
    seen.add(childStreamId);
    out.push(childStreamId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// generic child-execution helpers
// ---------------------------------------------------------------------------

export function childExecutionLabel(
  child: Pick<ActiveChildInfo, 'identity' | 'agentName' | 'executionId'>,
): string {
  // RunIdentity is the declared authority for the row label; agentName and
  // executionId are only fallbacks for a malformed roster entry.
  if (child.identity) {
    return runIdentityDisplayName(child.identity);
  }
  return child.agentName || child.executionId;
}
