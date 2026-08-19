/** Group tree, ungrouped rows, and chronological timeline indices. */

import type { TaskGroup } from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import { compareBySeqNo } from '@shared/streams/streamOrdering';

export interface GroupTree {
  group: TaskGroup;
  children: GroupTree[];
  rows: TranscriptRow[];
}

export type TimelineEntry =
  | { key: string; time: number; row: TranscriptRow }
  | { key: string; time: number; tree: GroupTree };

type RowTimelineEntry = Extract<TimelineEntry, { row: TranscriptRow }>;

interface RowLocation {
  ungroupedIndex?: number;
  timelineEntry?: RowTimelineEntry;
}

/** The wall-clock fallback order key for a log row. */
function rowTime(row: TranscriptRow): number {
  return row.timestamp ?? 0;
}

/** Full-rebuild fallback: rows missing a timestamp sort last. */
function rowTimeForRebuild(row: TranscriptRow): number {
  return row.timestamp ?? Number.MAX_SAFE_INTEGER;
}

/** The wall-clock fallback order key for a task-group child. */
function groupStartTime(group: TaskGroup): number {
  return group.startTime;
}

/** Full-rebuild fallback: root groups missing a start time sort last. */
function groupStartTimeForRebuild(group: TaskGroup): number {
  return group.startTime ?? Number.MAX_SAFE_INTEGER;
}

function compareRows(a: TranscriptRow, b: TranscriptRow): number {
  return compareBySeqNo(a, b, (row) => row.seqNo, rowTime);
}

function compareRowsForRebuild(a: TranscriptRow, b: TranscriptRow): number {
  return compareBySeqNo(a, b, (row) => row.seqNo, rowTimeForRebuild);
}

function compareGroups(a: TaskGroup, b: TaskGroup): number {
  return compareBySeqNo(a, b, () => undefined, groupStartTime);
}

function compareRootGroups(a: TaskGroup, b: TaskGroup): number {
  return compareBySeqNo(a, b, () => undefined, groupStartTimeForRebuild);
}

function compareTimeline(a: TimelineEntry, b: TimelineEntry): number {
  return a.time - b.time;
}

/**
 * Insert into a comparator-sorted array in place and return the insertion
 * index. O(1) push when appending (common case — order increases), O(n)
 * splice otherwise.
 */
function insertByOrder<T>(
  target: T[],
  entry: T,
  compare: (a: T, b: T) => number,
): number {
  const last = target.at(-1);
  if (last !== undefined && compare(last, entry) <= 0) {
    target.push(entry);
    return target.length - 1;
  }
  const idx = target.findIndex((item) => compare(entry, item) < 0);
  if (idx < 0) {
    target.push(entry);
    return target.length - 1;
  }
  target.splice(idx, 0, entry);
  return idx;
}

/** One reactive update of `groups` / `rows` / `terminal`. */
interface TranscriptIndexUpdate {
  /** Terminal render mode is active for this update. */
  terminal: boolean;
  /** Terminal render mode was active for the previous update. */
  wasTerminal: boolean;
  groups: readonly TaskGroup[];
  previousGroups: readonly TaskGroup[] | undefined;
  groupsChanged: boolean;
  rows: readonly TranscriptRow[];
  previousRows: readonly TranscriptRow[] | undefined;
  rowsChanged: boolean;
  /** Indices the delta touched, or null when the range must be scanned. */
  deltaIndices: readonly number[] | null;
}

/**
 * Owns the derived data structures for the non-terminal render path:
 * the hierarchical group tree, the ungrouped row list, the interleaved
 * timeline, and the lookup indices that keep incremental updates O(1) per
 * touched entry.
 */
export class TranscriptIndex {
  tree: GroupTree[] = [];
  ungrouped: TranscriptRow[] = [];
  timeline: TimelineEntry[] = [];

  /** Both derived locations for an ungrouped row, keyed once by ID. */
  private rowLocations = new Map<string, RowLocation>();

  /** O(1) lookup from groupId → tree node. */
  private groupNodeIndex = new Map<string, GroupTree>();

  /**
   * Bring every derived structure up to date for one render update, choosing
   * the incremental path where the change allows it and a rebuild where it
   * does not. Ordering between the tree and the timeline lives here so no
   * caller has to reproduce it.
   *
   * Returns true when the caller must reset its render windows, i.e. when the
   * timeline no longer lines up with the windows the previous render used.
   */
  apply(update: TranscriptIndexUpdate): boolean {
    const {
      terminal,
      wasTerminal,
      groups,
      previousGroups,
      groupsChanged,
      rows,
      previousRows,
      rowsChanged,
      deltaIndices,
    } = update;

    // Terminal mode renders raw text, so the derived structures are neither
    // read nor maintained while it is on.
    if (terminal) return false;

    // Terminal mode just switched off: the caches went stale while it was on.
    if (wasTerminal) {
      this.rebuildTree(groups, rows);
      this.rebuildTimeline();
      return true;
    }

    const previousCount = previousRows?.length ?? 0;
    const patchedGroupMetadata =
      groupsChanged &&
      previousGroups !== undefined &&
      this.patchGroupMetadataIfShapeStable(previousGroups, groups);
    let renderWindowsStale = false;

    if (groupsChanged && !patchedGroupMetadata) {
      this.rebuildTree(groups, rows);
    } else if (rowsChanged) {
      if (rows.length === previousCount && previousRows) {
        this.updateCachedRowRefs(rows, previousRows, deltaIndices);
      } else if (rows.length > previousCount) {
        this.appendNewRows(rows, previousCount);
        // A LOG_DELTA batch may also contain updates to existing entries
        // (e.g. tool status → completed) alongside the appended entries.
        if (previousRows) {
          this.updateCachedRowRefs(
            rows,
            previousRows,
            deltaIndices,
            previousCount,
          );
        }
      } else {
        this.rebuildTree(groups, rows);
        renderWindowsStale = true;
      }
    }

    // Recompute the interleaved timeline incrementally when possible so the
    // earliest ungrouped row (the user's original instruction) stays at
    // the top for both tool-use and workflow streams.
    if (groupsChanged || rowsChanged) {
      if (
        (groupsChanged && !patchedGroupMetadata) ||
        rows.length < previousCount
      ) {
        this.rebuildTimeline();
      } else if (rowsChanged && rows.length > previousCount) {
        this.appendToTimeline(rows, previousCount);
        this.updateTimelineRowRefs(rows, deltaIndices);
      } else if (rowsChanged) {
        this.updateTimelineRowRefs(rows, deltaIndices);
      }
    }

    return renderWindowsStale;
  }

  /**
   * Patch status/name/end-time changes into the existing group tree.
   * Returns true when the tree shape is stable and metadata was patched in
   * place, false when callers must perform a full rebuild.
   */
  patchGroupMetadataIfShapeStable(
    previousGroups: readonly TaskGroup[],
    nextGroups: readonly TaskGroup[],
  ): boolean {
    if (previousGroups.length !== nextGroups.length) return false;

    for (let i = 0; i < nextGroups.length; i++) {
      const previous = previousGroups[i];
      const next = nextGroups[i];
      if (!previous || !next) return false;
      if (
        previous.id !== next.id ||
        previous.parentGroupId !== next.parentGroupId ||
        previous.startTime !== next.startTime
      ) {
        return false;
      }
      if (!this.groupNodeIndex.has(next.id)) return false;
    }

    for (const group of nextGroups) {
      this.groupNodeIndex.get(group.id)!.group = group;
    }
    return true;
  }

  /**
   * Build hierarchical tree from flat groups array.
   * Messages are classified purely by groupId — initial user rows have
   * no groupId (logged before the run stage via beginRunStage), while
   * follow-ups inherit their group.
   */
  rebuildTree(
    groups: readonly TaskGroup[],
    rows: readonly TranscriptRow[],
  ): void {
    const groupMap = new Map<string, TaskGroup>();
    const childrenMap = new Map<string, TaskGroup[]>();

    for (const group of groups) {
      groupMap.set(group.id, group);
      if (group.parentGroupId) {
        const siblings = childrenMap.get(group.parentGroupId) ?? [];
        siblings.push(group);
        childrenMap.set(group.parentGroupId, siblings);
      }
    }

    // Sort rows by wire append sequence and classify by groupId. Rows
    // without a usable sequence (archived/compat) fall back to timestamp.
    // JS engines use stable sort, so equal order keys preserve original order.
    const sortedRows = rows.toSorted(compareRowsForRebuild);
    const rowsByGroup = new Map<string, TranscriptRow[]>();
    const ungrouped: TranscriptRow[] = [];
    this.rowLocations.clear();

    for (const row of sortedRows) {
      if (row.groupId && groupMap.has(row.groupId)) {
        const bucket = rowsByGroup.get(row.groupId) ?? [];
        bucket.push(row);
        rowsByGroup.set(row.groupId, bucket);
      } else {
        this.rowLocations.set(row.id, {
          ungroupedIndex: ungrouped.length,
        });
        ungrouped.push(row);
      }
    }

    this.groupNodeIndex.clear();
    const nodeIndex = this.groupNodeIndex;
    function buildNode(group: TaskGroup): GroupTree {
      const node: GroupTree = {
        group,
        children: (childrenMap.get(group.id) ?? [])
          .sort(compareGroups)
          .map(buildNode),
        rows: rowsByGroup.get(group.id) ?? [],
      };
      nodeIndex.set(group.id, node);
      return node;
    }

    // Get root groups, sorted by start time. A group counts as a root when it
    // has no parent OR its parent is absent from this set (a dangling parent —
    // e.g. a cross-trace id the stream never recorded). Re-rooting orphans here
    // makes them degrade gracefully (rendered un-nested at the timeline top)
    // instead of vanishing silently along with their whole subtree and rows.
    // See docs/proposals/2026-05-30-progress-grouping-refactor.md (R2).
    // Stable sort preserves original order for equal order keys.
    this.tree = groups
      .filter((g) => !g.parentGroupId || !groupMap.has(g.parentGroupId))
      .sort(compareRootGroups)
      .map(buildNode);
    this.ungrouped = ungrouped;
  }

  /** Build full chronological timeline from current tree + ungrouped. */
  rebuildTimeline(): void {
    const timeline: TimelineEntry[] = [
      ...this.ungrouped.map((m) => ({
        key: m.id,
        time: m.timestamp ?? 0,
        row: m,
      })),
      ...this.tree.map((t) => ({
        key: t.group.id,
        time: t.group.startTime ?? 0,
        tree: t,
      })),
    ].sort(compareTimeline);
    this.timeline = timeline;
    for (const item of timeline) {
      if ('row' in item) {
        this.locationFor(item.key).timelineEntry = item;
      }
    }
  }

  /**
   * Incrementally classify rows appended since `startIndex`.
   * Avoids full tree rebuilds by classifying only new rows and inserting
   * by append-sequence order (timestamp fallback).
   */
  appendNewRows(rows: readonly TranscriptRow[], startIndex: number): void {
    for (let i = startIndex; i < rows.length; i++) {
      const row = rows[i];
      const node = row.groupId ? this.groupNodeIndex.get(row.groupId) : null;
      if (node) {
        this.removeUngroupedEntry(row.id);
        insertByOrder(node.rows, row, compareRows);
      } else {
        const index = insertByOrder(this.ungrouped, row, compareRows);
        this.reindexUngroupedFrom(index);
      }
    }
  }

  /**
   * Insert timeline entries for ungrouped rows appended since `startIndex`.
   * Grouped rows are already referenced via their tree node in timeline,
   * so we skip them here. Iterating the rows slice — rather than the
   * ungrouped array — keeps this correct when a row with an earlier
   * order key gets spliced into the middle of `ungrouped` by
   * `appendNewRows`.
   */
  appendToTimeline(rows: readonly TranscriptRow[], startIndex: number): void {
    for (let i = startIndex; i < rows.length; i++) {
      const m = rows[i];
      if (m.groupId && this.groupNodeIndex.has(m.groupId)) continue;
      const entry: RowTimelineEntry = {
        key: m.id,
        time: rowTime(m),
        row: m,
      };
      insertByOrder(this.timeline, entry, compareTimeline);
      this.locationFor(entry.key).timelineEntry = entry;
    }
  }

  /**
   * Replace stale row references in cached structures with fresh ones.
   * Pass `upTo` to limit scanning to a prefix range (used when a LOG_DELTA
   * batch also appends new entries beyond `upTo`).
   *
   * When delta indices are supplied they are used directly; otherwise the
   * caller-side range is scanned with O(1) reference comparison.
   *
   * A resync that renumbers entries (hydration merging disk history under
   * live appends) replays the whole log through this ordinary upsert path.
   * Replacing renumbered rows in place would leave the homogeneous arrays
   * (`node.rows` / `ungrouped`) out of comparator order, so detect an
   * ordering-key change up front and rebuild those arrays from the current
   * snapshot instead. The time-only timeline is deliberately untouched.
   */
  updateCachedRowRefs(
    rows: readonly TranscriptRow[],
    prevRows: readonly TranscriptRow[],
    deltaIndices: readonly number[] | null,
    upTo: number = rows.length,
  ): void {
    if (this.orderingKeyChanged(rows, prevRows, deltaIndices, upTo)) {
      this.rebuildRowArrays(rows);
      return;
    }

    if (deltaIndices) {
      for (const index of deltaIndices) {
        if (index < 0 || index >= upTo || index >= rows.length) continue;
        if (rows[index] !== prevRows[index]) {
          this.replaceSingleRow(rows[index]);
        }
      }
      return;
    }

    for (let i = upTo - 1; i >= 0; i--) {
      if (rows[i] !== prevRows[i]) {
        this.replaceSingleRow(rows[i]);
      }
    }
  }

  /**
   * Whether any replaced ref in this batch changed its order key. The
   * homogeneous arrays are ordered by `(usable seqNo, timestamp)`, so compare
   * those two fields directly: `compareRows(prev, next) !== 0` would
   * miss a seqNo presence/value change whenever the timestamp-fallback
   * tie-break reports equality.
   */
  private orderingKeyChanged(
    rows: readonly TranscriptRow[],
    prevRows: readonly TranscriptRow[],
    deltaIndices: readonly number[] | null,
    upTo: number,
  ): boolean {
    const changed = (prev: TranscriptRow, next: TranscriptRow): boolean =>
      next !== prev &&
      (prev.seqNo !== next.seqNo || prev.timestamp !== next.timestamp);

    if (deltaIndices) {
      for (const index of deltaIndices) {
        if (index < 0 || index >= upTo || index >= rows.length) continue;
        if (changed(prevRows[index], rows[index])) return true;
      }
      return false;
    }

    for (let i = upTo - 1; i >= 0; i--) {
      if (changed(prevRows[i], rows[i])) return true;
    }
    return false;
  }

  /**
   * Re-derive the homogeneous row arrays (`node.rows` / `ungrouped`)
   * from the current snapshot in rebuild order — the same
   * `compareRowsForRebuild` fallback `rebuildTree` uses. Used when a
   * delta batch changed ordering keys, where in-place replacement cannot
   * preserve the sorted invariant. The group tree shape and the time-only
   * timeline are left untouched; the caller's `updateTimelineRowRefs`
   * pass refreshes timeline row refs.
   */
  private rebuildRowArrays(rows: readonly TranscriptRow[]): void {
    const sorted = rows.toSorted(compareRowsForRebuild);
    const rowsByGroup = new Map<string, TranscriptRow[]>();
    const ungrouped: TranscriptRow[] = [];

    for (const row of sorted) {
      const node = row.groupId
        ? this.groupNodeIndex.get(row.groupId)
        : undefined;
      if (node) {
        const bucket = rowsByGroup.get(node.group.id) ?? [];
        bucket.push(row);
        rowsByGroup.set(node.group.id, bucket);
      } else {
        ungrouped.push(row);
      }
    }

    for (const node of this.groupNodeIndex.values()) {
      node.rows = rowsByGroup.get(node.group.id) ?? [];
    }
    this.ungrouped = ungrouped;

    // Rebuild ungrouped indices without discarding timeline refs. Iterate the
    // location map (rather than only reindexing the new array) so stale
    // indices on rows that left the ungrouped array are dropped too.
    for (const location of this.rowLocations.values()) {
      delete location.ungroupedIndex;
    }
    for (let i = 0; i < ungrouped.length; i++) {
      this.locationFor(ungrouped[i].id).ungroupedIndex = i;
    }
  }

  /**
   * Update row refs on existing timeline entries.
   * Full scan — status updates can target any position, not just the tail.
   */
  updateTimelineRowRefs(
    rows: readonly TranscriptRow[],
    deltaIndices: readonly number[] | null,
  ): void {
    if (deltaIndices) {
      for (const index of deltaIndices) {
        const row = rows[index];
        if (!row) continue;
        const timelineEntry = this.rowLocations.get(row.id)?.timelineEntry;
        if (timelineEntry) {
          timelineEntry.row = row;
        }
      }
      return;
    }

    for (let i = this.timeline.length - 1; i >= 0; i--) {
      const item = this.timeline[i];
      if (!item || !('row' in item)) continue;
      const ungroupedIndex = this.rowLocations.get(item.key)?.ungroupedIndex;
      const fresh =
        ungroupedIndex === undefined
          ? undefined
          : this.ungrouped[ungroupedIndex];
      if (fresh && fresh !== item.row) {
        item.row = fresh;
      }
    }
  }

  /**
   * Replace a single row ref in the cached tree. O(1) node lookup + O(k)
   * findIndex. Mutates arrays in-place — safe because caches are private
   * fields (not tracked by Lit), the render is already scheduled from the
   * `rows` @property change, and guard([m]) detects updated refs.
   */
  private replaceSingleRow(row: TranscriptRow): void {
    // Try group node first (O(1) lookup). A row with groupId may live in
    // ungrouped if the group didn't exist at classification time,
    // so fall through to ungrouped search on miss.
    if (row.groupId) {
      const node = this.groupNodeIndex.get(row.groupId);
      if (node) {
        this.removeUngroupedEntry(row.id);
        const idx = node.rows.findIndex((m) => m.id === row.id);
        if (idx >= 0) {
          node.rows[idx] = row;
          return;
        }
      }
    }

    const indexed = this.rowLocations.get(row.id)?.ungroupedIndex;
    if (indexed !== undefined && this.ungrouped[indexed]?.id === row.id) {
      this.ungrouped[indexed] = row;
      return;
    }

    const idx = this.ungrouped.findIndex((m) => m.id === row.id);
    if (idx >= 0) {
      this.ungrouped[idx] = row;
      this.locationFor(row.id).ungroupedIndex = idx;
    }
  }

  /** The mutable location record for a row, created on first use. */
  private locationFor(id: string): RowLocation {
    const existing = this.rowLocations.get(id);
    if (existing) return existing;
    const created: RowLocation = {};
    this.rowLocations.set(id, created);
    return created;
  }

  private reindexUngroupedFrom(startIndex: number): void {
    for (let i = startIndex; i < this.ungrouped.length; i++) {
      this.locationFor(this.ungrouped[i].id).ungroupedIndex = i;
    }
  }

  private removeUngroupedEntry(id: string): void {
    const location = this.rowLocations.get(id);
    if (!location) return;
    if (location.timelineEntry) {
      delete location.ungroupedIndex;
    } else {
      this.rowLocations.delete(id);
    }
  }
}
