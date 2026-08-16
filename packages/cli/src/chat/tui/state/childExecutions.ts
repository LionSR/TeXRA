// Owner of the CLI TUI's child-stream relationship state: the live
// active-subagent roster, the retained child-stream history, and the current
// child -> parent topology. These are three views of one child-stream
// record — kept in one signal-backed map (`CHILD_STREAMS`) instead of three
// separately-mutated collections — with different authority and lifetime
// rules exposed only through the pure selectors below.
//
// See docs/proposals/2026-07-10-cli-child-stream-state-consolidation.md for the
// accepted design, the load-bearing event-ordering census, and the
// transition/selector semantics this module implements.

import { computed, signal, type Signal } from '@lit-labs/signals';
import {
  runIdentityDisplayName,
  type ActiveChildInfo,
  type RunIdentity,
  type StreamTabId,
} from '@shared/schemas';

import type { StreamSlice } from './cliState';

interface RetainedParent {
  readonly streamId: StreamTabId;
  /** One-based, first-seen order within `streamId`. */
  readonly order: number;
}

type ParentProvenance =
  | {
      /** No explicit edge fact yet; the first roster owns current topology. */
      readonly kind: 'roster';
      readonly retained: RetainedParent;
    }
  | {
      /** Explicit edge wins; null means promotion to top level. */
      readonly kind: 'explicit';
      readonly streamId: StreamTabId | null;
      /** Historical first-roster placement, independent of current topology. */
      readonly retained?: RetainedParent;
    };

interface LiveChildStreamEntry {
  readonly kind: 'live';
  /** Latest roster metadata (identity included), excluding the stream id
   *  (the map key) and the lagging display `status`. */
  readonly summary?: Omit<ActiveChildInfo, 'childStreamId' | 'status'>;
  /** Whether the current parent roster still includes this child. */
  readonly active: boolean;
  /** Current topology and its authority, plus optional retained history. */
  readonly parent?: ParentProvenance;
}

interface RemovedChildStreamEntry {
  readonly kind: 'removed';
  /** Children whose parent edge this removal cleared. They are the only
   *  streams that can still name this id as a parent, so the tombstone is
   *  pinned (never evicted) while any of them is still live. */
  readonly orphanedChildren?: readonly StreamTabId[];
}

/** One live child relationship or an explicit removal tombstone. */
export type ChildStreamEntry = LiveChildStreamEntry | RemovedChildStreamEntry;

export type ChildStreamEntries = ReadonlyMap<StreamTabId, ChildStreamEntry>;

const CHILD_STREAMS = signal<ChildStreamEntries>(new Map());

/**
 * Memory bound on retained removal tombstones. A long chat session can remove
 * thousands of child streams; the oldest tombstone is dropped first and live
 * entries are never evicted. Mirrors the progress view's
 * `RETAINED_FINISHED_CHILDREN_CAP` (`SessionFactApplier.ts`) as a value, not
 * an import: the two containers hold different records and the CLI must not
 * deep-import controller internals.
 */
const REMOVED_STREAM_TOMBSTONE_CAP = 200;

/**
 * Read-only view of the child-stream relationship map for components that
 * need to re-render on a change (subscribe via `useSignal`). Never write
 * through this — use the transition functions below.
 */
export const childStreamEntries: Signal.Computed<ChildStreamEntries> = computed(
  () => CHILD_STREAMS.get(),
);

/** Retained execution-id → human label projection for executions tool rows. */
export const subagentExecutionLabels: Signal.Computed<
  ReadonlyMap<string, string>
> = computed(() => {
  const labels = new Map<string, string>();
  for (const entry of CHILD_STREAMS.get().values()) {
    if (entry.kind === 'removed' || !entry.summary) continue;
    const label = childExecutionLabel(entry.summary);
    if (label !== entry.summary.executionId) {
      labels.set(entry.summary.executionId, label);
    }
  }
  return labels;
});

function retainedParent(
  entry: LiveChildStreamEntry | undefined,
): RetainedParent | undefined {
  return entry?.parent?.retained;
}

function currentParent(
  entry: LiveChildStreamEntry | undefined,
): StreamTabId | null | undefined {
  if (!entry?.parent) return undefined;
  return entry.parent.kind === 'explicit'
    ? entry.parent.streamId
    : entry.parent.retained.streamId;
}

/**
 * The current parent for a non-removed child: explicit edge wins over a
 * roster-derived provisional parent, and a tombstoned candidate parent
 * resolves to no parent (so late child facts cannot revive a removed
 * ancestor).
 */
function effectiveParentFromEntries(
  childStreamId: StreamTabId,
  entries: ChildStreamEntries,
): StreamTabId | undefined {
  const entry = entries.get(childStreamId);
  if (!entry || entry.kind === 'removed') return undefined;
  const candidate = currentParent(entry);
  if (!candidate) return undefined;
  if (entries.get(candidate)?.kind === 'removed') return undefined;
  return candidate;
}

/**
 * Derived child -> current-parent topology. Not stored or independently
 * mutated — recomputed from `CHILD_STREAMS` on every read. Kept under the
 * same export name/shape the CLI previously stored as a writable signal so
 * every existing `useSignal(parentStream)` consumer is unchanged.
 */
export const parentStream: Signal.Computed<
  ReadonlyMap<StreamTabId, StreamTabId>
> = computed(() => {
  const entries = CHILD_STREAMS.get();
  const out = new Map<StreamTabId, StreamTabId>();
  for (const childStreamId of entries.keys()) {
    const parent = effectiveParentFromEntries(childStreamId, entries);
    if (parent) out.set(childStreamId, parent);
  }
  return out;
});

/** Whether a stream identity (child or parent) carries a removal tombstone. */
export function isChildStreamRemoved(streamId: StreamTabId): boolean {
  return CHILD_STREAMS.get().get(streamId)?.kind === 'removed';
}

export function resetChildStreamEntries(): void {
  CHILD_STREAMS.set(new Map());
}

// ---------------------------------------------------------------------------
// transitions
// ---------------------------------------------------------------------------

/**
 * Explicit `setParentStream(child, parent)` session fact. `null` means the
 * runtime promoted the child to a top-level stream. An explicit edge
 * outranks roster-derived topology and, once observed, only a later
 * explicit edge can change current topology again.
 */
export function setParentStream(
  childStreamId: StreamTabId,
  parentStreamId: StreamTabId | null | undefined,
): void {
  if (parentStreamId === undefined) return;
  const current = CHILD_STREAMS.get();
  const entry = current.get(childStreamId);
  if (entry?.kind === 'removed') return;
  if (
    parentStreamId !== null &&
    current.get(parentStreamId)?.kind === 'removed'
  ) {
    return;
  }
  if (
    entry?.parent?.kind === 'explicit' &&
    entry.parent.streamId === parentStreamId
  ) {
    return;
  }

  const live = entry ?? { kind: 'live', active: false };
  const retained = retainedParent(live);
  const next: LiveChildStreamEntry = {
    ...live,
    parent: {
      kind: 'explicit',
      streamId: parentStreamId,
      ...(retained && { retained }),
    },
    active: live.active && currentParent(live) === parentStreamId,
  };
  const out = new Map(current);
  out.set(childStreamId, next);
  CHILD_STREAMS.set(out);
}

/** Field-by-field comparison of the persisted roster summary — avoids a
 *  spurious `changed` on a same-content roster snapshot the runtime resends
 *  as a fresh array/object on every poll.
 *
 *  `elapsed` is compared like every other field: `AgentRunLifecycle`
 *  untracks a finishing child (omitting it from the next roster) *before*
 *  transitioning its stream to a terminal phase, so a roster tick carrying
 *  both a terminal `status` and a fresh `elapsed` never happens in practice —
 *  the last roster snapshot this child appears in is always `running`. If
 *  `elapsed` were dropped from this comparison while the child is running,
 *  the cached summary would freeze at whichever tick happened to be the
 *  first one where the other fields settled (typically the very first
 *  tick), not the last live value before removal, and that stale, near-zero
 *  duration is what the retained row and `formatPostCompactionContext` would
 *  read verbatim. */
function summaryUnchanged(
  a: LiveChildStreamEntry['summary'],
  b: LiveChildStreamEntry['summary'],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.agentName === b.agentName &&
    a.executionId === b.executionId &&
    a.startedAt === b.startedAt &&
    a.elapsed === b.elapsed &&
    // `finishedAt` is stamped once and frozen, but it is the retention
    // marker: without comparing it, the live -> retained transition of an
    // otherwise-identical row would read as a no-op.
    a.finishedAt === b.finishedAt &&
    sameIdentity(a.identity, b.identity) &&
    a.workflowPhase === b.workflowPhase
  );
}

/** Structural identity equality — roster polls resend fresh objects, so a
 *  reference compare would defeat the no-op detection on every tick. */
function sameIdentity(a: RunIdentity, b: RunIdentity): boolean {
  switch (a.kind) {
    case 'agent':
      return b.kind === 'agent' && a.agent === b.agent && a.tool === b.tool;
    case 'process':
      return b.kind === 'process' && a.tool === b.tool;
    case 'multiAgentWorkflow':
      return (
        b.kind === 'multiAgentWorkflow' && a.workflowName === b.workflowName
      );
  }
}

/** Whether applying `nextEntry` over `entry` would be a no-op. */
function subagentEntryUnchanged(
  entry: LiveChildStreamEntry | undefined,
  nextEntry: LiveChildStreamEntry,
): boolean {
  return (
    entry !== undefined &&
    entry.active === nextEntry.active &&
    entry.parent === nextEntry.parent &&
    summaryUnchanged(entry.summary, nextEntry.summary)
  );
}

/**
 * `child.activity` roster snapshot for one parent. The applier's roster is
 * complete for that parent at this hub position and splits by `finishedAt`
 * presence (the schema contract): rows without it are the active-membership
 * snapshot; rows with it are finished children retained for display —
 * history, never active membership. A placement whose row was recorded as
 * retained is dropped exactly when the roster stops listing it (the
 * applier's retained-cap eviction); a row only ever seen live keeps its
 * placement on omission — the applier never emits a finished non-process
 * child without `finishedAt`, so an omitted live-only row is a process
 * child it never retains (or a direct unit-level projection). A late roster
 * from an incompatible (explicitly edged-elsewhere, or promoted) child
 * cannot resurrect active membership or overwrite a newer parent's summary
 * metadata.
 */
export function projectChildRoster(
  parentStreamId: StreamTabId,
  children: readonly ActiveChildInfo[],
): void {
  const current = CHILD_STREAMS.get();
  if (current.get(parentStreamId)?.kind === 'removed') return;

  const snapshotIds = new Set<StreamTabId>();
  const live = new Map<StreamTabId, ActiveChildInfo>();
  const retainedRows = new Map<StreamTabId, ActiveChildInfo>();
  for (const child of children) {
    snapshotIds.add(child.childStreamId);
    const entry = current.get(child.childStreamId);
    if (entry?.kind === 'removed') continue;
    const parent = currentParent(entry);
    if (parent !== undefined && parent !== parentStreamId) continue;
    (child.finishedAt === undefined ? live : retainedRows).set(
      child.childStreamId,
      child,
    );
  }

  let maxRetainedOrder = 0;
  for (const entry of current.values()) {
    if (entry.kind === 'removed') continue;
    const retained = retainedParent(entry);
    if (retained?.streamId === parentStreamId) {
      maxRetainedOrder = Math.max(maxRetainedOrder, retained.order);
    }
  }

  const out = new Map(current);
  let changed = false;

  // Clear active membership for entries previously active under this parent
  // but absent or incompatible with this snapshot — including rows that
  // arrived as retained history this time.
  for (const [childStreamId, entry] of current) {
    if (
      entry.kind === 'removed' ||
      !entry.active ||
      currentParent(entry) !== parentStreamId
    ) {
      continue;
    }
    if (live.has(childStreamId)) continue;
    out.set(childStreamId, { ...entry, active: false });
    changed = true;
  }

  // Live rows first, then retained history: the applier's emission order, so
  // first-seen retained order matches the roster.
  for (const [rows, active] of [
    [live, true],
    [retainedRows, false],
  ] as const) {
    for (const [childStreamId, child] of rows) {
      const currentEntry = out.get(childStreamId);
      const entry = currentEntry?.kind === 'live' ? currentEntry : undefined;
      const {
        childStreamId: _childStreamId,
        status: _status,
        ...summary
      } = child;
      const existingRetained = retainedParent(entry);
      const retained =
        existingRetained ??
        ({
          streamId: parentStreamId,
          order: ++maxRetainedOrder,
        } satisfies RetainedParent);
      let parent = entry?.parent;
      if (!parent) {
        parent = { kind: 'roster', retained };
      } else if (parent.kind === 'explicit' && !parent.retained) {
        parent = { ...parent, retained };
      }
      const nextEntry: LiveChildStreamEntry = {
        ...(entry ?? { kind: 'live' as const }),
        summary,
        active,
        parent,
      };
      if (subagentEntryUnchanged(entry, nextEntry)) continue;
      out.set(childStreamId, nextEntry);
      changed = true;
    }
  }

  // Retained-membership sync: once a stored row carries `finishedAt` (the
  // shared roster had retained it), its placement is dropped as soon as the
  // roster stops listing the row — the applier only drops retained rows via
  // its cap, so this propagates cap evictions exactly. Live-only rows are
  // untouched (see the contract above). A roster-kind parent whose placement
  // is dropped degrades to an explicit top-level edge, mirroring
  // `applyChildStreamRemoval`'s conversion.
  for (const [childStreamId, entry] of out) {
    if (entry.kind === 'removed') continue;
    if (entry.summary?.finishedAt === undefined) continue;
    const retained = retainedParent(entry);
    if (retained?.streamId !== parentStreamId) continue;
    if (snapshotIds.has(childStreamId)) continue;
    const parent: ParentProvenance =
      entry.parent?.kind === 'explicit'
        ? { kind: 'explicit', streamId: entry.parent.streamId }
        : { kind: 'explicit', streamId: null };
    out.set(childStreamId, { ...entry, parent });
    changed = true;
  }

  if (changed) CHILD_STREAMS.set(out);
}

/**
 * `removeStream` fact for a child or parent stream identity. Tombstones the
 * stream so no later roster, edge, attachment, or status fact can
 * resurrect it, and — when the removed stream was itself a parent — clears
 * every association pointing at it, replacing current-topology edges with
 * explicit top-level edges so no selector returns it as an ancestor.
 */
export function applyChildStreamRemoval(streamId: StreamTabId): void {
  const current = CHILD_STREAMS.get();
  const out = new Map(current);
  const orphanedChildren: StreamTabId[] = [];

  for (const [childStreamId, entry] of current) {
    if (childStreamId === streamId || entry.kind === 'removed') continue;
    const beforeParent = currentParent(entry);
    const retained = retainedParent(entry);
    const nextRetained = retained?.streamId === streamId ? undefined : retained;
    if (beforeParent === streamId || retained?.streamId === streamId) {
      orphanedChildren.push(childStreamId);
    }
    let parent = entry.parent;
    if (parent?.kind === 'roster' && !nextRetained) {
      parent = { kind: 'explicit', streamId: null };
    } else if (parent?.kind === 'explicit') {
      const streamIdValue =
        parent.streamId === streamId ? null : parent.streamId;
      if (
        streamIdValue !== parent.streamId ||
        nextRetained !== parent.retained
      ) {
        parent = {
          kind: 'explicit',
          streamId: streamIdValue,
          ...(nextRetained && { retained: nextRetained }),
        };
      }
    }
    const active = beforeParent !== streamId && entry.active;
    if (active !== entry.active || parent !== entry.parent) {
      out.set(childStreamId, { ...entry, active, parent });
    }
  }

  out.set(streamId, {
    kind: 'removed',
    ...(orphanedChildren.length > 0 && { orphanedChildren }),
  });
  evictOldestTombstones(out);
  CHILD_STREAMS.set(out);
}

/**
 * Drop the oldest tombstones once they exceed `REMOVED_STREAM_TOMBSTONE_CAP`.
 * Map order is first-seen order for the stream identity, so the oldest
 * removals go first.
 *
 * A tombstone is pinned while any child it orphaned is still live: those
 * children are the only streams that can still name it as a parent, so
 * dropping it would let a late edge fact re-attach them to a removed
 * ancestor. Once such a child is itself removed, its own tombstone refuses
 * that same late fact and the parent tombstone becomes redundant.
 */
function evictOldestTombstones(
  entries: Map<StreamTabId, ChildStreamEntry>,
): void {
  const tombstones = [...entries].filter(
    (pair): pair is [StreamTabId, RemovedChildStreamEntry] =>
      pair[1].kind === 'removed',
  );
  let excess = tombstones.length - REMOVED_STREAM_TOMBSTONE_CAP;
  if (excess <= 0) return;

  for (const [streamId, tombstone] of tombstones) {
    if (excess === 0) break;
    const pinned = tombstone.orphanedChildren?.some(
      (childStreamId) => entries.get(childStreamId)?.kind === 'live',
    );
    if (pinned) continue;
    entries.delete(streamId);
    excess -= 1;
  }
}

// ---------------------------------------------------------------------------
// selectors
// ---------------------------------------------------------------------------

function reconstruct(
  childStreamId: StreamTabId,
  entry: LiveChildStreamEntry,
  streams: ReadonlyMap<StreamTabId, Pick<StreamSlice, 'status'>>,
): ActiveChildInfo | undefined {
  if (!entry.summary) return undefined;
  return {
    ...entry.summary,
    childStreamId,
    status: streams.get(childStreamId)?.status,
  };
}

/**
 * Active subagent roster for a parent: entries whose active membership was
 * last confirmed by that parent's roster and whose current effective parent
 * still agrees. A terminal status that arrives after roster removal cannot
 * make a retained child active again — this selector, not status, decides
 * killability.
 */
export function activeSubagentsFor(
  parentStreamId: StreamTabId,
  entries: ChildStreamEntries,
  streams: ReadonlyMap<StreamTabId, Pick<StreamSlice, 'status'>>,
): readonly ActiveChildInfo[] {
  if (entries.get(parentStreamId)?.kind === 'removed') return [];
  const out: ActiveChildInfo[] = [];
  for (const [childStreamId, entry] of entries) {
    if (entry.kind === 'removed' || !entry.active) {
      continue;
    }
    if (effectiveParentFromEntries(childStreamId, entries) !== parentStreamId) {
      continue;
    }
    const info = reconstruct(childStreamId, entry, streams);
    if (info) out.push(info);
  }
  return out;
}

/**
 * Retained child-stream history for a parent, in first-seen order. Survives
 * terminal status, and — for rows only ever seen live — roster omission;
 * once a row is recorded as retained (`finishedAt`), its membership mirrors
 * the parent's shared roster exactly, so cap eviction erases the
 * association, as does explicit removal of the child or this parent.
 */
export function retainedChildStreamsFor(
  parentStreamId: StreamTabId,
  entries: ChildStreamEntries,
  streams: ReadonlyMap<StreamTabId, Pick<StreamSlice, 'status'>>,
): readonly ActiveChildInfo[] {
  if (entries.get(parentStreamId)?.kind === 'removed') return [];
  const rows: Array<{ order: number; info: ActiveChildInfo }> = [];
  for (const [childStreamId, entry] of entries) {
    if (entry.kind === 'removed') {
      continue;
    }
    const retained = retainedParent(entry);
    if (retained?.streamId !== parentStreamId) continue;
    const info = reconstruct(childStreamId, entry, streams);
    if (info) rows.push({ order: retained.order, info });
  }
  rows.sort((left, right) => left.order - right.order);
  return rows.map((row) => row.info);
}

/**
 * Retained order is primary; active metadata overlays the matching retained
 * row, and active children not yet retained are appended as a partial-state
 * fallback. Composition only — not cached in another signal.
 *
 * The data model intentionally keeps two overlapping collections — retained
 * children (a historical snapshot, ordered) and active children (current
 * topology) — because a child can be both retained and still active. Dedup
 * belongs here at the merge site: retained order wins, and an active child
 * already present in retained is overlaid rather than duplicated. Normalizing
 * to a single source upstream would couple the two producers' ordering, which
 * is not worth it for a pure display projection.
 */
export function visibleSubagentRows(
  parentStreamId: StreamTabId,
  entries: ChildStreamEntries,
  streams: ReadonlyMap<StreamTabId, Pick<StreamSlice, 'status'>>,
): readonly ActiveChildInfo[] {
  const retained = retainedChildStreamsFor(parentStreamId, entries, streams);
  const active = activeSubagentsFor(parentStreamId, entries, streams);
  const activeByKey = new Map(
    active.map((child) => [child.childStreamId, child]),
  );
  const retainedKeys = new Set(retained.map((child) => child.childStreamId));
  return [
    ...retained.map((child) => activeByKey.get(child.childStreamId) ?? child),
    ...active.filter((child) => !retainedKeys.has(child.childStreamId)),
  ];
}

/**
 * Focus-cycle order for a parent's descendants: retained children first (in
 * retained order), then current-topology children not already present (in
 * map insertion order). Deliberately broader than current topology alone —
 * a promoted retained row stays a historical focus target from its former
 * parent. A child `StreamSlice` must exist before it is focusable.
 */
export function focusOrderDescendants(
  parentStreamId: StreamTabId,
  entries: ChildStreamEntries,
  streams: ReadonlyMap<StreamTabId, StreamSlice>,
): readonly StreamTabId[] {
  const out: StreamTabId[] = [];
  const seen = new Set<StreamTabId>();
  for (const child of retainedChildStreamsFor(
    parentStreamId,
    entries,
    streams,
  )) {
    if (!streams.has(child.childStreamId) || seen.has(child.childStreamId)) {
      continue;
    }
    seen.add(child.childStreamId);
    out.push(child.childStreamId);
  }
  for (const [childStreamId, entry] of entries) {
    if (entry.kind === 'removed' || seen.has(childStreamId)) continue;
    if (effectiveParentFromEntries(childStreamId, entries) !== parentStreamId) {
      continue;
    }
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
