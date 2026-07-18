// Owner of the CLI TUI's child-stream relationship state: the live
// active-subagent roster, the retained child-stream history, and the current
// child -> parent topology. These are three views of one child-stream
// record — kept in one signal-backed map (`CHILD_STREAMS`) instead of three
// separately-mutated collections — with different authority and lifetime
// rules exposed only through the pure selectors below.
//
// See docs/proposals/cli-child-stream-state-consolidation.md for the
// accepted design, the load-bearing event-ordering census, and the
// transition/selector semantics this module implements. `activeProcesses`
// is explicitly out of scope: a process has no `childStreamId` and no
// independent `StreamSlice`, so it stays a plain `StreamSlice` field.

import { computed, signal, type Signal } from '@lit-labs/signals';
import type {
  ActiveChildInfo,
  StreamTabId,
  SubagentChildInfo,
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
  /** Latest roster metadata, excluding identity and status. */
  readonly summary?: Omit<SubagentChildInfo, 'childStreamId' | 'status'>;
  /** Whether the current parent roster still includes this child. */
  readonly active: boolean;
  /** Current topology and its authority, plus optional retained history. */
  readonly parent?: ParentProvenance;
}

interface RemovedChildStreamEntry {
  readonly kind: 'removed';
}

/** One live child relationship or an explicit removal tombstone. */
export type ChildStreamEntry = LiveChildStreamEntry | RemovedChildStreamEntry;

export type ChildStreamEntries = ReadonlyMap<StreamTabId, ChildStreamEntry>;

const CHILD_STREAMS = signal<ChildStreamEntries>(new Map());

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
  if (!entry?.parent) return undefined;
  return entry.parent.retained;
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
 *  as a fresh array/object on every poll. */
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
    a.toolName === b.toolName
  );
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
 * `child.activity(kind: 'subagents')` roster snapshot for one parent: the
 * accepted children become the complete active-membership snapshot for that
 * parent at this hub position. A late roster from an incompatible (explicitly
 * edged-elsewhere, or promoted) child cannot resurrect active membership or
 * overwrite a newer parent's summary metadata.
 */
export function applySubagentRoster(
  parentStreamId: StreamTabId,
  children: readonly ActiveChildInfo[],
): void {
  const current = CHILD_STREAMS.get();
  if (current.get(parentStreamId)?.kind === 'removed') return;

  const subagents = children.filter(
    (child): child is SubagentChildInfo => child.kind === 'subagent',
  );

  const accepted = new Map<StreamTabId, SubagentChildInfo>();
  for (const child of subagents) {
    const entry = current.get(child.childStreamId);
    if (entry?.kind === 'removed') continue;
    const parent = currentParent(entry);
    if (parent !== undefined && parent !== parentStreamId) continue;
    accepted.set(child.childStreamId, child);
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
  // but absent or incompatible with this snapshot.
  for (const [childStreamId, entry] of current) {
    if (
      entry.kind === 'removed' ||
      !entry.active ||
      currentParent(entry) !== parentStreamId
    ) {
      continue;
    }
    if (accepted.has(childStreamId)) continue;
    out.set(childStreamId, { ...entry, active: false });
    changed = true;
  }

  for (const [childStreamId, child] of accepted) {
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
      active: true,
      parent,
    };
    if (subagentEntryUnchanged(entry, nextEntry)) continue;
    out.set(childStreamId, nextEntry);
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
  out.set(streamId, { kind: 'removed' });

  for (const [childStreamId, entry] of current) {
    if (childStreamId === streamId || entry.kind === 'removed') continue;
    const beforeParent = currentParent(entry);
    const retained = retainedParent(entry);
    const nextRetained = retained?.streamId === streamId ? undefined : retained;
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
    const active = beforeParent === streamId ? false : entry.active;
    const next: LiveChildStreamEntry = {
      ...entry,
      active,
      parent,
    };
    if (active !== entry.active || parent !== entry.parent) {
      out.set(childStreamId, next);
    }
  }

  CHILD_STREAMS.set(out);
}

// ---------------------------------------------------------------------------
// selectors
// ---------------------------------------------------------------------------

function reconstruct(
  childStreamId: StreamTabId,
  entry: LiveChildStreamEntry,
  streams: ReadonlyMap<StreamTabId, Pick<StreamSlice, 'status'>>,
): SubagentChildInfo | undefined {
  if (!entry.summary) return undefined;
  return {
    ...entry.summary,
    kind: 'subagent',
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
): readonly SubagentChildInfo[] {
  if (entries.get(parentStreamId)?.kind === 'removed') return [];
  const out: SubagentChildInfo[] = [];
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
 * roster omission and terminal status; only explicit removal of the child or
 * this parent erases the association.
 */
export function retainedChildStreamsFor(
  parentStreamId: StreamTabId,
  entries: ChildStreamEntries,
  streams: ReadonlyMap<StreamTabId, Pick<StreamSlice, 'status'>>,
): readonly SubagentChildInfo[] {
  if (entries.get(parentStreamId)?.kind === 'removed') return [];
  const rows: Array<{ order: number; info: SubagentChildInfo }> = [];
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
 */
export function visibleSubagentRows(
  parentStreamId: StreamTabId,
  entries: ChildStreamEntries,
  streams: ReadonlyMap<StreamTabId, Pick<StreamSlice, 'status'>>,
): readonly SubagentChildInfo[] {
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
// generic child-execution helpers (subagents and processes)
// ---------------------------------------------------------------------------

export function childExecutionKey(child: ActiveChildInfo): string {
  return child.kind === 'subagent' ? child.childStreamId : child.executionId;
}

export function childExecutionLabel(
  child: Pick<ActiveChildInfo, 'agentName' | 'executionId' | 'toolName'>,
): string {
  // The agent name is always set by the runtime (for both kinds), so it's the
  // label; toolName/executionId are just defensive fallbacks for a malformed
  // entry. `kind` isn't needed here — it's `childExecutionKey` that actually
  // discriminates (only subagents have a stream tab to key by).
  return child.agentName || child.toolName || child.executionId;
}
