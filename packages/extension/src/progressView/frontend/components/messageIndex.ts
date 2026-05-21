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

  private ungroupedById = new Map<string, LogMessageData>();
  private ungroupedIndex = new Map<string, number>();

  /** O(1) lookup from groupId → tree node. */
  private groupNodeIndex = new Map<string, GroupTree>();

  /** O(1) lookup from ungrouped message ID → timeline index. */
  private timelineMessageIndex = new Map<string, number>();

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
    const sortedMessages = [...messages].sort(
      (a, b) =>
        (a.timestamp ?? Number.MAX_SAFE_INTEGER) -
        (b.timestamp ?? Number.MAX_SAFE_INTEGER),
    );
    const messagesByGroup = new Map<string, LogMessageData[]>();
    const ungrouped: LogMessageData[] = [];
    this.ungroupedById.clear();
    this.ungroupedIndex.clear();

    for (const msg of sortedMessages) {
      if (msg.groupId && groupMap.has(msg.groupId)) {
        const bucket = messagesByGroup.get(msg.groupId) ?? [];
        bucket.push(msg);
        messagesByGroup.set(msg.groupId, bucket);
      } else {
        this.ungroupedIndex.set(msg.id, ungrouped.length);
        this.ungroupedById.set(msg.id, msg);
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

    // Get root groups (no parent), sorted by start time.
    // Stable sort preserves original order for equal timestamps.
    this.tree = groups
      .filter((g) => !g.parentGroupId)
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
    this.timelineMessageIndex.clear();
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if ('msg' in item) this.timelineMessageIndex.set(item.key, i);
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
        this.insertMessageInPlace(node.messages, msg);
      } else {
        const index = this.insertMessageInPlace(this.ungrouped, msg);
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
      const inGroupNode = m.groupId
        ? this.groupNodeIndex.has(m.groupId)
        : false;
      if (inGroupNode) continue;
      const entry: TimelineEntry = {
        key: m.id,
        time: m.timestamp ?? 0,
        msg: m,
      };
      const lastTime =
        this.timeline.length > 0 ? this.timeline.at(-1)!.time : -Infinity;
      if (entry.time >= lastTime) {
        this.timelineMessageIndex.set(entry.key, this.timeline.length);
        this.timeline.push(entry);
      } else {
        const idx = this.timeline.findIndex((e) => e.time > entry.time);
        if (idx >= 0) {
          this.timeline.splice(idx, 0, entry);
          this.reindexTimelineFrom(idx);
        } else {
          this.timelineMessageIndex.set(entry.key, this.timeline.length);
          this.timeline.push(entry);
        }
      }
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
        const timelineIndex = this.timelineMessageIndex.get(msg.id);
        if (timelineIndex === undefined) continue;
        const item = this.timeline[timelineIndex];
        if (item && 'msg' in item && item.key === msg.id) {
          item.msg = msg;
        }
      }
      return;
    }

    for (let i = this.timeline.length - 1; i >= 0; i--) {
      const item = this.timeline[i];
      if (!('msg' in item)) continue;
      const fresh = this.ungroupedById.get(item.key);
      if (fresh && fresh !== item.msg) {
        (item as { msg: LogMessageData }).msg = fresh;
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

    const indexed = this.ungroupedIndex.get(msg.id);
    if (indexed !== undefined && this.ungrouped[indexed]?.id === msg.id) {
      this.ungrouped[indexed] = msg;
      this.ungroupedById.set(msg.id, msg);
      return;
    }

    const idx = this.ungrouped.findIndex((m) => m.id === msg.id);
    if (idx >= 0) {
      this.ungrouped[idx] = msg;
      this.ungroupedIndex.set(msg.id, idx);
      this.ungroupedById.set(msg.id, msg);
    }
  }

  /**
   * Insert a message into a sorted array in-place.
   * O(1) push when appending (common case — timestamps increase), O(n) splice
   * otherwise.
   */
  private insertMessageInPlace(
    target: LogMessageData[],
    message: LogMessageData,
  ): number {
    const msgTime = message.timestamp ?? 0;
    const lastTs =
      target.length > 0 ? (target.at(-1)!.timestamp ?? 0) : -Infinity;
    if (msgTime >= lastTs) {
      target.push(message);
      return target.length - 1;
    }
    const idx = target.findIndex((e) => (e.timestamp ?? 0) > msgTime);
    if (idx >= 0) {
      target.splice(idx, 0, message);
      return idx;
    }
    target.push(message);
    return target.length - 1;
  }

  private reindexTimelineFrom(startIndex: number): void {
    for (let i = startIndex; i < this.timeline.length; i++) {
      const item = this.timeline[i];
      if ('msg' in item) this.timelineMessageIndex.set(item.key, i);
    }
  }

  private reindexUngroupedFrom(startIndex: number): void {
    for (let i = startIndex; i < this.ungrouped.length; i++) {
      const message = this.ungrouped[i];
      this.ungroupedIndex.set(message.id, i);
      this.ungroupedById.set(message.id, message);
    }
  }

  private removeUngroupedEntry(id: string): void {
    this.ungroupedIndex.delete(id);
    this.ungroupedById.delete(id);
  }
}
