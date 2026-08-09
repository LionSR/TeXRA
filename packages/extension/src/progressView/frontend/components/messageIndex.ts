/** Group tree, ungrouped messages, and chronological timeline indices. */

import type { LogMessageData, TaskGroup } from '@shared/schemas';

export interface GroupTree {
  group: TaskGroup;
  children: GroupTree[];
  messages: LogMessageData[];
}

export type TimelineEntry =
  | { key: string; time: number; msg: LogMessageData }
  | { key: string; time: number; tree: GroupTree };

type MessageTimelineEntry = Extract<TimelineEntry, { msg: LogMessageData }>;

interface MessageLocation {
  ungroupedIndex?: number;
  timelineEntry?: MessageTimelineEntry;
}

/**
 * Insert into a time-sorted array in place and return the insertion index.
 * O(1) push when appending (common case — times increase), O(n) splice
 * otherwise.
 */
function insertByTime<T>(
  target: T[],
  entry: T,
  timeOf: (item: T) => number,
): number {
  const time = timeOf(entry);
  const lastTime = target.length > 0 ? timeOf(target.at(-1)!) : -Infinity;
  if (time >= lastTime) {
    target.push(entry);
    return target.length - 1;
  }
  // findIndex always returns >= 0 here: we only reach this point when the
  // target is non-empty and time < lastTime, so the last element satisfies
  // the predicate.
  const idx = target.findIndex((item) => timeOf(item) > time);
  target.splice(idx, 0, entry);
  return idx;
}

function messageTime(message: LogMessageData): number {
  return message.timestamp ?? 0;
}

/** One reactive update of `groups` / `messages` / `terminal`. */
interface MessageIndexUpdate {
  /** Terminal render mode is active for this update. */
  terminal: boolean;
  /** Terminal render mode was active for the previous update. */
  wasTerminal: boolean;
  groups: readonly TaskGroup[];
  previousGroups: readonly TaskGroup[] | undefined;
  groupsChanged: boolean;
  messages: readonly LogMessageData[];
  previousMessages: readonly LogMessageData[] | undefined;
  messagesChanged: boolean;
  /** Indices the delta touched, or null when the range must be scanned. */
  deltaIndices: readonly number[] | null;
}

/**
 * Owns the derived data structures for the non-terminal render path:
 * the hierarchical group tree, the ungrouped message list, the interleaved
 * timeline, and the lookup indices that keep incremental updates O(1) per
 * touched entry.
 */
export class MessageIndex {
  tree: GroupTree[] = [];
  ungrouped: LogMessageData[] = [];
  timeline: TimelineEntry[] = [];

  /** Both derived locations for an ungrouped message, keyed once by ID. */
  private messageLocations = new Map<string, MessageLocation>();

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
  apply(update: MessageIndexUpdate): boolean {
    const {
      groups,
      previousGroups,
      groupsChanged,
      messages,
      previousMessages,
      messagesChanged,
      deltaIndices,
    } = update;

    // Terminal mode renders raw text, so the derived structures are neither
    // read nor maintained while it is on.
    if (update.terminal) return false;

    // Terminal mode just switched off: the caches went stale while it was on.
    if (update.wasTerminal) {
      this.rebuildTree(groups, messages);
      this.rebuildTimeline();
      return true;
    }

    const previousCount = previousMessages?.length ?? 0;
    const patchedGroupMetadata =
      groupsChanged && previousGroups
        ? this.patchGroupMetadataIfShapeStable(previousGroups, groups)
        : false;
    let renderWindowsStale = false;

    if (groupsChanged && !patchedGroupMetadata) {
      this.rebuildTree(groups, messages);
    } else if (messagesChanged) {
      if (messages.length === previousCount && previousMessages) {
        this.updateCachedMessageRefs(messages, previousMessages, deltaIndices);
      } else if (messages.length > previousCount) {
        this.appendNewMessages(messages, previousCount);
        // A LOG_DELTA batch may also contain updates to existing entries
        // (e.g. tool status → completed) alongside the appended entries.
        if (previousMessages) {
          this.updateCachedMessageRefs(
            messages,
            previousMessages,
            deltaIndices,
            previousCount,
          );
        }
      } else {
        this.rebuildTree(groups, messages);
        renderWindowsStale = true;
      }
    }

    // Recompute the interleaved timeline incrementally when possible so the
    // earliest ungrouped message (the user's original instruction) stays at
    // the top for both tool-use and workflow streams.
    if (groupsChanged || messagesChanged) {
      if (
        (groupsChanged && !patchedGroupMetadata) ||
        messages.length < previousCount
      ) {
        this.rebuildTimeline();
      } else if (messagesChanged && messages.length > previousCount) {
        this.appendToTimeline(messages, previousCount);
        this.updateTimelineMessageRefs(messages, deltaIndices);
      } else if (messagesChanged) {
        this.updateTimelineMessageRefs(messages, deltaIndices);
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
   * Messages are classified purely by groupId — initial user messages have
   * no groupId (logged before the run stage via beginRunStage), while
   * follow-ups inherit their group.
   */
  rebuildTree(
    groups: readonly TaskGroup[],
    messages: readonly LogMessageData[],
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

    // Sort messages by timestamp and classify by groupId.
    // JS engines use stable sort, so equal timestamps preserve original order.
    const sortedMessages = messages.toSorted(
      (a, b) =>
        (a.timestamp ?? Number.MAX_SAFE_INTEGER) -
        (b.timestamp ?? Number.MAX_SAFE_INTEGER),
    );
    const messagesByGroup = new Map<string, LogMessageData[]>();
    const ungrouped: LogMessageData[] = [];
    this.messageLocations.clear();

    for (const msg of sortedMessages) {
      if (msg.groupId && groupMap.has(msg.groupId)) {
        const bucket = messagesByGroup.get(msg.groupId) ?? [];
        bucket.push(msg);
        messagesByGroup.set(msg.groupId, bucket);
      } else {
        this.messageLocations.set(msg.id, {
          ungroupedIndex: ungrouped.length,
        });
        ungrouped.push(msg);
      }
    }

    this.groupNodeIndex.clear();
    const nodeIndex = this.groupNodeIndex;
    function buildNode(group: TaskGroup): GroupTree {
      const node: GroupTree = {
        group,
        children: (childrenMap.get(group.id) ?? [])
          .sort((a, b) => a.startTime - b.startTime)
          .map(buildNode),
        messages: messagesByGroup.get(group.id) ?? [],
      };
      nodeIndex.set(group.id, node);
      return node;
    }

    // Get root groups, sorted by start time. A group counts as a root when it
    // has no parent OR its parent is absent from this set (a dangling parent —
    // e.g. a cross-trace id the stream never recorded). Re-rooting orphans here
    // makes them degrade gracefully (rendered un-nested at the timeline top)
    // instead of vanishing silently along with their whole subtree and messages.
    // See docs/proposals/2026-05-30-progress-grouping-refactor.md (R2).
    // Stable sort preserves original order for equal timestamps.
    this.tree = groups
      .filter((g) => !g.parentGroupId || !groupMap.has(g.parentGroupId))
      .sort(
        (a, b) =>
          (a.startTime ?? Number.MAX_SAFE_INTEGER) -
          (b.startTime ?? Number.MAX_SAFE_INTEGER),
      )
      .map(buildNode);
    this.ungrouped = ungrouped;
  }

  /** Build full chronological timeline from current tree + ungrouped. */
  rebuildTimeline(): void {
    const timeline: TimelineEntry[] = [
      ...this.ungrouped.map((m) => ({
        key: m.id,
        time: m.timestamp ?? 0,
        msg: m,
      })),
      ...this.tree.map((t) => ({
        key: t.group.id,
        time: t.group.startTime ?? 0,
        tree: t,
      })),
    ].sort((a, b) => a.time - b.time);
    this.timeline = timeline;
    for (const item of timeline) {
      if ('msg' in item) {
        this.locationFor(item.key).timelineEntry = item;
      }
    }
  }

  /**
   * Incrementally classify messages appended since `startIndex`.
   * Avoids full tree rebuilds by classifying only new messages and inserting
   * by timestamp.
   */
  appendNewMessages(
    messages: readonly LogMessageData[],
    startIndex: number,
  ): void {
    for (let i = startIndex; i < messages.length; i++) {
      const msg = messages[i];
      const node = msg.groupId ? this.groupNodeIndex.get(msg.groupId) : null;
      if (node) {
        this.removeUngroupedEntry(msg.id);
        insertByTime(node.messages, msg, messageTime);
      } else {
        const index = insertByTime(this.ungrouped, msg, messageTime);
        this.reindexUngroupedFrom(index);
      }
    }
  }

  /**
   * Insert timeline entries for ungrouped messages appended since `startIndex`.
   * Grouped messages are already referenced via their tree node in timeline,
   * so we skip them here. Iterating the messages slice — rather than the
   * ungrouped array — keeps this correct when a message with an earlier
   * timestamp gets spliced into the middle of `ungrouped` by
   * `appendNewMessages`.
   */
  appendToTimeline(
    messages: readonly LogMessageData[],
    startIndex: number,
  ): void {
    for (let i = startIndex; i < messages.length; i++) {
      const m = messages[i];
      if (m.groupId && this.groupNodeIndex.has(m.groupId)) continue;
      const entry: MessageTimelineEntry = {
        key: m.id,
        time: messageTime(m),
        msg: m,
      };
      insertByTime(this.timeline, entry, (item) => item.time);
      this.locationFor(entry.key).timelineEntry = entry;
    }
  }

  /**
   * Replace stale message references in cached structures with fresh ones.
   * Pass `upTo` to limit scanning to a prefix range (used when a LOG_DELTA
   * batch also appends new entries beyond `upTo`).
   *
   * When delta indices are supplied they are used directly; otherwise the
   * caller-side range is scanned with O(1) reference comparison.
   */
  updateCachedMessageRefs(
    messages: readonly LogMessageData[],
    prevMessages: readonly LogMessageData[],
    deltaIndices: readonly number[] | null,
    upTo: number = messages.length,
  ): void {
    if (deltaIndices) {
      for (const index of deltaIndices) {
        if (index < 0 || index >= upTo || index >= messages.length) continue;
        if (messages[index] !== prevMessages[index]) {
          this.replaceSingleMessage(messages[index]);
        }
      }
      return;
    }

    for (let i = upTo - 1; i >= 0; i--) {
      if (messages[i] !== prevMessages[i]) {
        this.replaceSingleMessage(messages[i]);
      }
    }
  }

  /**
   * Update message refs on existing timeline entries.
   * Full scan — status updates can target any position, not just the tail.
   */
  updateTimelineMessageRefs(
    messages: readonly LogMessageData[],
    deltaIndices: readonly number[] | null,
  ): void {
    if (deltaIndices) {
      for (const index of deltaIndices) {
        const msg = messages[index];
        if (!msg) continue;
        const timelineEntry = this.messageLocations.get(msg.id)?.timelineEntry;
        if (timelineEntry) {
          timelineEntry.msg = msg;
        }
      }
      return;
    }

    for (let i = this.timeline.length - 1; i >= 0; i--) {
      const item = this.timeline[i];
      if (!item || !('msg' in item)) continue;
      const ungroupedIndex = this.messageLocations.get(
        item.key,
      )?.ungroupedIndex;
      const fresh =
        ungroupedIndex === undefined
          ? undefined
          : this.ungrouped[ungroupedIndex];
      if (fresh && fresh !== item.msg) {
        item.msg = fresh;
      }
    }
  }

  /**
   * Replace a single message ref in the cached tree. O(1) node lookup + O(k)
   * findIndex. Mutates arrays in-place — safe because caches are private
   * fields (not tracked by Lit), the render is already scheduled from the
   * `messages` @property change, and guard([m]) detects updated refs.
   */
  private replaceSingleMessage(msg: LogMessageData): void {
    // Try group node first (O(1) lookup). A message with groupId may live in
    // ungrouped if the group didn't exist at classification time,
    // so fall through to ungrouped search on miss.
    if (msg.groupId) {
      const node = this.groupNodeIndex.get(msg.groupId);
      if (node) {
        this.removeUngroupedEntry(msg.id);
        const idx = node.messages.findIndex((m) => m.id === msg.id);
        if (idx >= 0) {
          node.messages[idx] = msg;
          return;
        }
      }
    }

    const indexed = this.messageLocations.get(msg.id)?.ungroupedIndex;
    if (indexed !== undefined && this.ungrouped[indexed]?.id === msg.id) {
      this.ungrouped[indexed] = msg;
      return;
    }

    const idx = this.ungrouped.findIndex((m) => m.id === msg.id);
    if (idx >= 0) {
      this.ungrouped[idx] = msg;
      this.locationFor(msg.id).ungroupedIndex = idx;
    }
  }

  /** The mutable location record for a message, created on first use. */
  private locationFor(id: string): MessageLocation {
    const existing = this.messageLocations.get(id);
    if (existing) return existing;
    const created: MessageLocation = {};
    this.messageLocations.set(id, created);
    return created;
  }

  private reindexUngroupedFrom(startIndex: number): void {
    for (let i = startIndex; i < this.ungrouped.length; i++) {
      this.locationFor(this.ungrouped[i].id).ungroupedIndex = i;
    }
  }

  private removeUngroupedEntry(id: string): void {
    const location = this.messageLocations.get(id);
    if (!location) return;
    if (location.timelineEntry) {
      delete location.ungroupedIndex;
    } else {
      this.messageLocations.delete(id);
    }
  }
}
