/** Declarative task group list — renders groups, headers, and log entries inline. */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { guard } from 'lit/directives/guard.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import stripAnsi from 'strip-ansi';

// Local imports - shared schemas
import { STREAM_STATUS } from '@shared/schemas';

// Local imports - shared utilities
// Side-effect imports - register WA icon and spinner components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';

import { designTokens } from '@shared/styles';
import type { LogMessageData, TaskGroup } from '@shared/schemas';
import { ToggleStateStore } from '@shared/state/ToggleStateStore';
import { scrollToBottom } from '@shared/utils/dom';
import { getGettingStartedHtml } from '@shared/utils/uiConstants';
import { formatDuration } from '@utils/core';

// Local imports - shared styles

// Local imports - progress view constants
import {
  ACTIVE_STREAM_STATUSES,
  ELEMENT_IDS,
  GROUP_DOM_IDS,
} from '../constants';

// Local imports - progress view styles
import { logStyles } from '../styles/logStyles';

// Local imports - progress view utils
import { playCompletionSound } from '../utils/audioNotification';

// Local imports - formatters
import { formatLogEntry } from '../formatters';
import { getTimeFormatter } from '../formatters/timestampUtils';

interface GroupTree {
  group: TaskGroup;
  children: GroupTree[];
  messages: LogMessageData[];
}

const PLACEHOLDER_HTML = getGettingStartedHtml(
  'No runs yet—use TeXRA commands to start. Try ',
);

const ESCAPE_CHARACTER = String.fromCharCode(27);
// Null byte used as a sentinel for ANSI erase-line sequences inside processTerminalText.
// Real null bytes in the input are stripped first so the sentinel is unambiguous.
const ERASE_SENTINEL = '\x00';
const ANSI_ERASE_LINE_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[\\d*K`, 'g');

/** Strip ANSI codes and simulate \r overwrite within each newline-delimited line. */
function processTerminalText(text: string): string {
  // Strip any real null bytes so \x00 is unambiguous as our internal sentinel.
  // Then replace ANSI erase-line escapes (\x1b[K, \x1b[0K, \x1b[2K, …) with it
  // before stripping all ANSI so the overwrite loop can honour them: an erase clears
  // the line from that column onward instead of preserving the stale tail characters.

  const preprocessed = text
    .split(ERASE_SENTINEL)
    .join('')
    .replaceAll(ANSI_ERASE_LINE_PATTERN, ERASE_SENTINEL);
  return stripAnsi(preprocessed)
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => {
      const segs = line.split('\r');
      // On a fresh line (no preceding \r), \x1b[K has nothing to clear; text after
      // the erase point is still written at the cursor, so just strip the markers.
      let current = segs[0]!.split(ERASE_SENTINEL).join('');

      for (let i = 1; i < segs.length; i++) {
        const seg = segs[i]!;
        const eraseAt = seg.indexOf(ERASE_SENTINEL);
        if (eraseAt >= 0) {
          // \r overlays the prefix up to the erase point; \x1b[K clears from there to EOL.
          const pre = seg.slice(0, eraseAt);
          const post = seg
            .slice(eraseAt + 1)
            .split(ERASE_SENTINEL)
            .join('');
          current = pre + post;
        } else {
          // \r moves cursor to column 0 without clearing; shorter writes preserve the tail
          current =
            seg.length < current.length ? seg + current.slice(seg.length) : seg;
        }
      }
      return current.split(ERASE_SENTINEL).join('');
    })
    .join('\n');
}

/** Maps group status to a wa-icon name; null indicates an animated spinner. */
function getStatusIcon(status: string): string | null {
  switch (status) {
    case STREAM_STATUS.RUNNING:
      return null;
    case STREAM_STATUS.ERROR:
      return 'error';
    case STREAM_STATUS.STOPPED:
      return 'check';
    default:
      return 'circle-outline';
  }
}

@customElement('task-group-list')
export class TaskGroupList extends LitElement {
  static override styles = [designTokens, ...logStyles];

  /** All task groups to render */
  @property({ attribute: false }) groups: TaskGroup[] = [];

  /** All log messages to render */
  @property({ attribute: false }) messages: LogMessageData[] = [];

  /**
   * Existing message indices updated by the most recent backend delta.
   * Null means the producer did not provide delta metadata, so fall back
   * to reference scans.
   */
  @property({ attribute: false }) updatedMessageIndices:
    | readonly number[]
    | null = null;

  /** Generation immediately before updatedMessageIndices was collected. */
  @property({ attribute: false }) updatedMessageBaseGeneration = 0;

  /** Current generation for the messages array. */
  @property({ attribute: false }) messageGeneration = 0;

  /** Whether there are any streams in the current filter (controls placeholder) */
  @property({ attribute: false }) hasStreams = false;

  /** Status for the active stream, used while a run exists before logs arrive. */
  @property({ attribute: false }) streamStatus: string | null = null;

  /** Toggle state store for persistence */
  @property({ attribute: false }) toggleStates: ToggleStateStore | null = null;

  /**
   * Render log output in terminal style (monospace, no bullets/timestamps).
   * Reflected to the host attribute so scoped CSS can target it.
   */
  @property({ type: Boolean, reflect: true }) terminal = false;

  /** Track previous group statuses to detect completion (not rendered — no @state needed) */
  private previousStatuses = new Map<string, string>();

  /** Memoized tree output from buildGroupTree() - recomputed only when inputs change */
  private cachedTree: GroupTree[] = [];
  private cachedUngrouped: LogMessageData[] = [];

  /** Raw partial-line buffer: unprocessed bytes after the last '\n', capped at 64 KiB */
  private cachedRawTail = '';
  /** Processed complete lines for terminal mode (up to and including the last '\n') */
  private cachedTerminalLines = '';

  /** O(1) lookup from groupId → tree node. Built during buildGroupTree(). */
  private groupNodeIndex = new Map<string, GroupTree>();

  /** Memoized tool-use timeline (ungrouped msgs + groups sorted chronologically) */
  private cachedTimeline: Array<
    | { key: string; time: number; msg: LogMessageData }
    | { key: string; time: number; tree: GroupTree }
  > = [];

  /** O(1) lookup from ungrouped message ID → cachedTimeline index. */
  private timelineMessageIndex = new Map<string, number>();

  /** Reference to the scroll container */
  @query(`#${ELEMENT_IDS.LOG_CONTENT}`)
  private scrollContainer?: HTMLElement;

  /** Terminal committed-line node, managed imperatively to avoid full text rewrites. */
  @query('.terminal-pre--committed')
  private terminalCommittedPre?: HTMLPreElement;

  /**
   * Sticky scroll state: when true, new content auto-scrolls to bottom.
   * Flips false when user scrolls away, true when user scrolls back to bottom.
   */
  private isSticky = true;

  /** Threshold for detecting "near bottom" in scroll listener (px) */
  private static readonly STICKY_THRESHOLD = 150;

  /** Text node currently attached to terminalCommittedPre. */
  private terminalCommittedTextNode: Text | null = null;

  /** Number of committed terminal characters already written to the DOM. */
  private renderedTerminalLinesLength = 0;

  /** True after a terminal cache rebuild, when incremental append is invalid. */
  private terminalCommittedNeedsReset = true;

  /** Message generation represented by the current cached tree/timeline. */
  private processedMessageGeneration = 0;

  /** Handle native scroll events from the log container to track user intent */
  private handleScroll = (): void => {
    this.isSticky = this.isNearBottom(TaskGroupList.STICKY_THRESHOLD);
  };

  /** Public method to scroll to bottom - called by parent LogList */
  scrollToBottom(): void {
    if (this.scrollContainer) {
      scrollToBottom(this.scrollContainer);
    }
  }

  /** Scroll to bottom only when sticky (user hasn't scrolled away). */
  scrollToBottomIfSticky(): void {
    if (!this.isSticky) return;
    this.scrollToBottom();
  }

  /** Force sticky state — called by parent on tab switch */
  setSticky(value: boolean): void {
    this.isSticky = value;
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has('groups')) {
      this.checkForCompletedRuns();
    }

    const groupsChanged = changedProperties.has('groups');
    const messagesChanged = changedProperties.has('messages');

    if (this.terminal) {
      if (changedProperties.has('terminal')) {
        this.rebuildTerminalText();
      } else if (messagesChanged) {
        const prevCount =
          (changedProperties.get('messages') as LogMessageData[] | undefined)
            ?.length ?? 0;
        if (this.messages.length > prevCount) {
          this.appendTerminalChunk(
            this.messages
              .slice(prevCount)
              .map((m) => m.text)
              .join(''),
          );
        } else {
          this.rebuildTerminalText();
        }
      }
    }

    // Group tree, message classification, and timeline are only used by the
    // non-terminal render path — skip them when terminal mode is active.
    if (this.terminal) return;

    // If terminal just switched off, caches weren't maintained while it was on —
    // do a full rebuild so the non-terminal render has accurate data.
    if (changedProperties.get('terminal') === true) {
      [this.cachedTree, this.cachedUngrouped] = this.buildGroupTree();
      this.cachedTimeline = this.buildFullTimeline();
      return;
    }

    const prevMessages = messagesChanged
      ? (changedProperties.get('messages') as LogMessageData[] | undefined)
      : undefined;
    const prevCount = prevMessages?.length ?? 0;

    if (groupsChanged) {
      // Structural change — always full rebuild
      [this.cachedTree, this.cachedUngrouped] = this.buildGroupTree();
    } else if (messagesChanged) {
      // Only messages changed — use Lit's old value to pick incremental path
      if (this.messages.length === prevCount && prevMessages) {
        // Same length: update changed refs (streaming output, status changes).
        this.updateCachedMessageRefs(prevMessages);
      } else if (this.messages.length > prevCount) {
        // Append-only: classify only the new messages incrementally.
        this.appendNewMessages(prevCount);
        // A LOG_DELTA batch may also contain updates to existing entries
        // (e.g. tool status → completed). Use explicit delta metadata when
        // available so pure appends do not scan the old message array.
        if (prevMessages)
          this.updateExistingMessageRefs(prevMessages, prevCount);
      } else {
        // Messages shrunk (e.g. clear) — full rebuild
        [this.cachedTree, this.cachedUngrouped] = this.buildGroupTree();
      }
    }

    // Recompute the interleaved timeline incrementally when possible.
    // Used by both tool-use and workflow streams so the user's original
    // instruction (the earliest ungrouped message) stays at the top.
    if (groupsChanged || messagesChanged) {
      if (groupsChanged || this.messages.length < prevCount) {
        // Structural change, or messages shrunk (e.g. clear/resync) —
        // removed IDs must be pruned from cachedTimeline, so rebuild.
        this.cachedTimeline = this.buildFullTimeline();
      } else if (this.messages.length > prevCount) {
        // Append-only: classify each new message and insert ungrouped ones
        // into the timeline. Iterate the messages slice (not the ungrouped
        // array) so a new message spliced into the middle of cachedUngrouped
        // by appendNewMessages still gets picked up.
        this.appendToTimeline(prevCount);
        // LOG_DELTA may also mutate existing timeline entries in the same batch.
        this.updateTimelineMessageRefs();
      } else {
        // Same length — streaming update. guard([item.msg]) in render()
        // detects new refs on existing timeline entries.
        this.updateTimelineMessageRefs();
      }
    }
  }

  override updated(): void {
    this.processedMessageGeneration = this.messageGeneration;

    if (this.terminal) {
      this.syncTerminalCommittedText();
      return;
    }

    this.terminalCommittedTextNode = null;
    this.renderedTerminalLinesLength = 0;
    this.terminalCommittedNeedsReset = true;
  }

  /**
   * Incrementally classify messages appended since `startIndex`.
   * Avoids full tree rebuilds by classifying only new messages and inserting by timestamp.
   */
  private appendNewMessages(startIndex: number): void {
    for (let i = startIndex; i < this.messages.length; i++) {
      const msg = this.messages[i];
      const node = msg.groupId ? this.groupNodeIndex.get(msg.groupId) : null;
      if (node) {
        this.insertMessageInPlace(node.messages, msg);
      } else {
        this.insertMessageInPlace(this.cachedUngrouped, msg);
      }
    }
  }

  /**
   * Insert a message into a sorted array in-place.
   * O(1) push when appending (common case — timestamps increase), O(n) splice otherwise.
   */
  private insertMessageInPlace(
    target: LogMessageData[],
    message: LogMessageData,
  ): void {
    const msgTime = message.timestamp ?? 0;
    const lastTs =
      target.length > 0 ? (target.at(-1)!.timestamp ?? 0) : -Infinity;
    if (msgTime >= lastTs) {
      target.push(message);
    } else {
      const idx = target.findIndex((e) => (e.timestamp ?? 0) > msgTime);
      if (idx >= 0) target.splice(idx, 0, message);
      else target.push(message);
    }
  }

  /**
   * Replace stale message references in cached structures with fresh ones.
   *
   * Full reverse scan — completion status updates can target any position
   * in the array (not just the tail), so early-exit would miss them.
   * Reference comparison is O(1) per element, making the full scan cheap.
   */
  private updateCachedMessageRefs(prevMessages: LogMessageData[]): void {
    if (this.canUseUpdatedMessageIndices()) {
      this.updateCachedMessageRefsByIndex(prevMessages);
      return;
    }

    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i] !== prevMessages[i]) {
        this.replaceSingleMessage(this.messages[i]);
      }
    }
  }

  /**
   * Scan entries in the pre-append range [0, upTo) for changed refs.
   * Called when a LOG_DELTA batch contains both new entries and updates
   * to existing entries (e.g. tool status in_progress → completed).
   */
  private updateExistingMessageRefs(
    prevMessages: LogMessageData[],
    upTo: number,
  ): void {
    if (this.canUseUpdatedMessageIndices()) {
      this.updateCachedMessageRefsByIndex(prevMessages, upTo);
      return;
    }

    for (let i = upTo - 1; i >= 0; i--) {
      if (this.messages[i] !== prevMessages[i]) {
        this.replaceSingleMessage(this.messages[i]);
      }
    }
  }

  private updateCachedMessageRefsByIndex(
    prevMessages: LogMessageData[],
    upTo: number = this.messages.length,
  ): void {
    const indices = this.updatedMessageIndices ?? [];
    for (const index of indices) {
      if (index < 0 || index >= upTo || index >= this.messages.length) continue;
      if (this.messages[index] !== prevMessages[index]) {
        this.replaceSingleMessage(this.messages[index]);
      }
    }
  }

  private canUseUpdatedMessageIndices(): boolean {
    return (
      this.updatedMessageIndices !== null &&
      this.updatedMessageBaseGeneration === this.processedMessageGeneration
    );
  }

  /**
   * Replace a single message ref in the cached tree. O(1) node lookup + O(k) findIndex.
   * Mutates arrays in-place — safe because cachedTree/cachedUngrouped are private fields
   * (not @property/@state), so Lit doesn't track their references. The render is already
   * scheduled from the `messages` @property change, and guard([m]) detects updated refs.
   */
  private replaceSingleMessage(msg: LogMessageData): void {
    // Try group node first (O(1) lookup). A message with groupId may live in
    // cachedUngrouped if the group didn't exist at classification time,
    // so fall through to ungrouped search on miss.
    if (msg.groupId) {
      const node = this.groupNodeIndex.get(msg.groupId);
      if (node) {
        const idx = node.messages.findIndex((m) => m.id === msg.id);
        if (idx >= 0) {
          node.messages[idx] = msg;
          return;
        }
      }
    }

    const idx = this.cachedUngrouped.findIndex((m) => m.id === msg.id);
    if (idx >= 0) {
      this.cachedUngrouped[idx] = msg;
    }
  }

  private rebuildTerminalText(): void {
    this.cachedRawTail = '';
    this.cachedTerminalLines = '';
    this.terminalCommittedNeedsReset = true;
    this.appendTerminalChunk(this.messages.map((m) => m.text).join(''));
  }

  private appendTerminalChunk(newRaw: string): void {
    const combined = this.cachedRawTail + newRaw;
    const lastNl = combined.lastIndexOf('\n');
    if (lastNl >= 0) {
      this.cachedTerminalLines += processTerminalText(
        combined.slice(0, lastNl + 1),
      );
      this.cachedRawTail = combined.slice(lastNl + 1);
    } else {
      // No newline: keep raw bytes so split ANSI sequences and cross-chunk \r
      // overwrites are handled correctly at render time. Cap unconditionally:
      // if the tail ends with \r (potential CRLF split) the cap still preserves
      // that trailing \r, so the next arriving \n is correctly joined into \r\n.
      const MAX_TAIL = 65536;
      this.cachedRawTail =
        combined.length > MAX_TAIL
          ? combined.slice(combined.length - MAX_TAIL)
          : combined;
    }
  }

  /** Play sound when a run group completes */
  private checkForCompletedRuns(): void {
    const nextStatuses = new Map<string, string>();
    for (const group of this.groups) {
      const prev = this.previousStatuses.get(group.id);
      const isRunGroup = /^r\d+$/.test(group.name);
      const wasRunning = prev === STREAM_STATUS.RUNNING;
      const isNowComplete =
        group.status === STREAM_STATUS.READY ||
        group.status === STREAM_STATUS.STOPPED;

      if (isRunGroup && wasRunning && isNowComplete) {
        playCompletionSound();
      }

      nextStatuses.set(group.id, group.status);
    }
    this.previousStatuses = nextStatuses;
  }

  /**
   * Build hierarchical tree from flat groups array.
   * Returns [tree, ungrouped] tuple. Messages are classified purely by
   * groupId — initial user messages have no groupId (logged before the
   * run stage via beginRunStage), while follow-ups inherit their group.
   */
  private buildGroupTree(): [GroupTree[], LogMessageData[]] {
    const groupMap = new Map<string, TaskGroup>();
    const childrenMap = new Map<string, TaskGroup[]>();

    // Index groups
    for (const group of this.groups) {
      groupMap.set(group.id, group);
      if (group.parentGroupId) {
        const siblings = childrenMap.get(group.parentGroupId) ?? [];
        siblings.push(group);
        childrenMap.set(group.parentGroupId, siblings);
      }
    }

    // Sort messages by timestamp and classify by groupId.
    // JS engines use stable sort, so equal timestamps preserve original order.
    const sortedMessages = [...this.messages].sort(
      (a, b) =>
        (a.timestamp ?? Number.MAX_SAFE_INTEGER) -
        (b.timestamp ?? Number.MAX_SAFE_INTEGER),
    );
    const messagesByGroup = new Map<string, LogMessageData[]>();
    const ungrouped: LogMessageData[] = [];

    for (const msg of sortedMessages) {
      if (msg.groupId && groupMap.has(msg.groupId)) {
        const bucket = messagesByGroup.get(msg.groupId) ?? [];
        bucket.push(msg);
        messagesByGroup.set(msg.groupId, bucket);
      } else {
        ungrouped.push(msg);
      }
    }

    // Build tree recursively, populating the groupId → node index
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
    const tree = this.groups
      .filter((g) => !g.parentGroupId)
      .sort(
        (a, b) =>
          (a.startTime ?? Number.MAX_SAFE_INTEGER) -
          (b.startTime ?? Number.MAX_SAFE_INTEGER),
      )
      .map(buildNode);

    return [tree, ungrouped];
  }

  /** Build full chronological timeline from cached tree + ungrouped. */
  private buildFullTimeline(): typeof this.cachedTimeline {
    const timeline = [
      ...this.cachedUngrouped.map((m) => ({
        key: m.id,
        time: m.timestamp ?? 0,
        msg: m,
      })),
      ...this.cachedTree.map((t) => ({
        key: t.group.id,
        time: t.group.startTime ?? 0,
        tree: t,
      })),
    ].sort((a, b) => a.time - b.time);
    this.rebuildTimelineMessageIndex(timeline);
    return timeline;
  }

  /**
   * Insert timeline entries for ungrouped messages appended since `startIndex`.
   * Grouped messages are already referenced via their tree node in timeline,
   * so we skip them here. Iterating the messages slice — rather than the
   * cachedUngrouped array — keeps this correct when a message with an earlier
   * timestamp gets spliced into the middle of cachedUngrouped by
   * appendNewMessages.
   */
  private appendToTimeline(startIndex: number): void {
    for (let i = startIndex; i < this.messages.length; i++) {
      const m = this.messages[i];
      const inGroupNode = m.groupId
        ? this.groupNodeIndex.has(m.groupId)
        : false;
      if (inGroupNode) continue;
      const entry = { key: m.id, time: m.timestamp ?? 0, msg: m };
      const lastTime =
        this.cachedTimeline.length > 0
          ? this.cachedTimeline.at(-1)!.time
          : -Infinity;
      if (entry.time >= lastTime) {
        this.timelineMessageIndex.set(entry.key, this.cachedTimeline.length);
        this.cachedTimeline.push(entry);
      } else {
        const idx = this.cachedTimeline.findIndex((e) => e.time > entry.time);
        if (idx >= 0) {
          this.cachedTimeline.splice(idx, 0, entry);
          this.reindexTimelineMessagesFrom(idx);
        } else {
          this.timelineMessageIndex.set(entry.key, this.cachedTimeline.length);
          this.cachedTimeline.push(entry);
        }
      }
    }
  }

  /**
   * Update message refs on existing timeline entries.
   * Full scan — status updates can target any position, not just the tail.
   */
  private updateTimelineMessageRefs(): void {
    if (this.canUseUpdatedMessageIndices()) {
      this.updateTimelineMessageRefsByIndex();
      return;
    }

    for (let i = this.cachedTimeline.length - 1; i >= 0; i--) {
      const item = this.cachedTimeline[i];
      if (!('msg' in item)) continue;
      const fresh = this.findUngroupedReverse(item.key);
      if (fresh && fresh !== item.msg) {
        (item as { msg: LogMessageData }).msg = fresh;
      }
    }
  }

  private updateTimelineMessageRefsByIndex(): void {
    const indices = this.updatedMessageIndices ?? [];
    for (const index of indices) {
      const msg = this.messages[index];
      if (!msg) continue;
      const timelineIndex = this.timelineMessageIndex.get(msg.id);
      if (timelineIndex === undefined) continue;
      const item = this.cachedTimeline[timelineIndex];
      if (item && 'msg' in item && item.key === msg.id) {
        item.msg = msg;
      }
    }
  }

  private rebuildTimelineMessageIndex(
    timeline: typeof this.cachedTimeline = this.cachedTimeline,
  ): void {
    this.timelineMessageIndex.clear();
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if ('msg' in item) {
        this.timelineMessageIndex.set(item.key, i);
      }
    }
  }

  private reindexTimelineMessagesFrom(startIndex: number): void {
    for (let i = startIndex; i < this.cachedTimeline.length; i++) {
      const item = this.cachedTimeline[i];
      if ('msg' in item) {
        this.timelineMessageIndex.set(item.key, i);
      }
    }
  }

  /** Find a message in cachedUngrouped by scanning from end (O(1) for tail changes). */
  private findUngroupedReverse(id: string): LogMessageData | undefined {
    for (let i = this.cachedUngrouped.length - 1; i >= 0; i--) {
      if (this.cachedUngrouped[i].id === id) return this.cachedUngrouped[i];
    }
    return undefined;
  }

  /** Check if a group is expanded */
  private isExpanded(groupId: string): boolean {
    if (!this.toggleStates) return true;
    return this.toggleStates.get(groupId) !== true;
  }

  private isNearBottom(threshold: number): boolean {
    if (!this.scrollContainer) return false;
    const vsElement = this.scrollContainer as HTMLElement & {
      scrollPos?: number;
      scrollMax?: number;
    };
    if (
      typeof vsElement.scrollPos === 'number' &&
      typeof vsElement.scrollMax === 'number'
    ) {
      return vsElement.scrollMax - vsElement.scrollPos <= threshold;
    }
    const remaining =
      this.scrollContainer.scrollHeight -
      this.scrollContainer.scrollTop -
      this.scrollContainer.clientHeight;
    return remaining <= threshold;
  }

  /** Handle details toggle — reads groupId from element ID to avoid closures */
  private handleDetailsToggle(event: Event): void {
    const details = event.currentTarget as HTMLDetailsElement;
    const groupId = details.id.slice(GROUP_DOM_IDS.DETAILS_PREFIX.length);
    if (this.toggleStates) {
      this.toggleStates.set(groupId, !details.open);
    }
    // Re-render to add/remove children from the DOM (lazy collapsed groups)
    this.requestUpdate();
  }

  /** Render child group header inline (only called for non-root groups) */
  private renderGroupHeader(group: TaskGroup): TemplateResult {
    const formattedStartTime = getTimeFormatter().format(
      new Date(group.startTime),
    );
    const durationText = group.endTime
      ? formatDuration(group.endTime - group.startTime)
      : '';

    const statusIcon = getStatusIcon(group.status);
    return html`
      <span class="group-status-icon">
        ${statusIcon
          ? html`<wa-icon
              library="texra"
              name=${statusIcon}
              aria-hidden="true"
            ></wa-icon>`
          : html`<wa-spinner></wa-spinner>`}
      </span>
      <span class="group-title">${group.name}</span>
      <span class="group-time">
        <span class="group-start-time" data-start=${String(group.startTime)}>
          <wa-icon library="texra" name="clock" aria-hidden="true"></wa-icon>
          ${formattedStartTime}
        </span>
        ${durationText
          ? html`<span class="group-duration">${durationText}</span>`
          : nothing}
      </span>
    `;
  }

  /** Render a group node and its children recursively */
  private renderGroupNode(node: GroupTree): TemplateResult | typeof nothing {
    const { group, children, messages } = node;
    const detailsId = `${GROUP_DOM_IDS.DETAILS_PREFIX}${group.id}`;
    const contentId = `${GROUP_DOM_IDS.CONTENT_PREFIX}${group.id}`;

    // Root groups: simple container (no collapsible), always render content
    if (!group.parentGroupId) {
      return html`
        <div id=${detailsId} class="log-group log-run" data-run-id=${group.id}>
          <div id=${contentId} class="log-group-content">
            ${repeat(
              messages,
              (m) => m.id,
              (m) => guard([m], () => formatLogEntry(m)),
            )}
            ${repeat(
              children,
              (c) => c.group.id,
              (c) => this.renderGroupNode(c),
            )}
          </div>
        </div>
      `;
    }

    // Child groups: collapsible details element.
    // Collapsed child groups contribute zero DOM nodes for their content.
    const expanded = this.isExpanded(group.id);

    return html`
      <details
        id=${detailsId}
        class="log-group"
        ?open=${expanded}
        @toggle=${this.handleDetailsToggle}
      >
        <summary
          id="${GROUP_DOM_IDS.HEADER_PREFIX}${group.id}"
          class=${classMap({
            'log-group-header': true,
            [`is-${group.status}`]: true,
          })}
        >
          ${this.renderGroupHeader(group)}
        </summary>
        <div id=${contentId} class="log-group-content">
          ${expanded
            ? html`${repeat(
                messages,
                (m) => m.id,
                (m) => guard([m], () => formatLogEntry(m)),
              )}${repeat(
                children,
                (c) => c.group.id,
                (c) => this.renderGroupNode(c),
              )}`
            : nothing}
        </div>
      </details>
    `;
  }

  private renderTerminalOutput(): TemplateResult {
    const tailText = processTerminalText(this.cachedRawTail);
    const committedClass = 'terminal-pre terminal-pre--committed';
    const tailClass = 'terminal-pre terminal-pre--tail';
    const committed = html`<pre class=${committedClass}></pre>`;
    const tail = html`<pre class=${tailClass}>${tailText}</pre>`;

    return html`<div class="terminal-container">${[committed, tail]}</div>`;
  }

  private syncTerminalCommittedText(): void {
    const pre = this.terminalCommittedPre;
    if (!pre) return;

    const next = this.cachedTerminalLines;
    const hasAttachedNode = this.terminalCommittedTextNode?.parentNode === pre;
    const shouldReset =
      this.terminalCommittedNeedsReset ||
      !hasAttachedNode ||
      next.length < this.renderedTerminalLinesLength;

    if (shouldReset) {
      pre.textContent = '';
      this.terminalCommittedTextNode =
        next.length > 0 ? document.createTextNode(next) : null;
      if (this.terminalCommittedTextNode) {
        pre.append(this.terminalCommittedTextNode);
      }
      this.renderedTerminalLinesLength = next.length;
      this.terminalCommittedNeedsReset = false;
      return;
    }

    if (next.length > this.renderedTerminalLinesLength) {
      if (!this.terminalCommittedTextNode) {
        this.terminalCommittedTextNode = document.createTextNode('');
        pre.append(this.terminalCommittedTextNode);
      }

      this.terminalCommittedTextNode.appendData(
        next.slice(this.renderedTerminalLinesLength),
      );
      this.renderedTerminalLinesLength = next.length;
    }

    this.terminalCommittedNeedsReset = false;
  }

  override render(): TemplateResult {
    // Show placeholder only when there are no streams in the current filter
    if (!this.hasStreams) {
      return html`
        <div
          id=${ELEMENT_IDS.LOG_CONTENT}
          class="log-container"
          @scroll=${this.handleScroll}
        >
          <div class="log-placeholder">${unsafeHTML(PLACEHOLDER_HTML)}</div>
        </div>
      `;
    }

    if (
      !this.terminal &&
      this.messages.length === 0 &&
      this.groups.length === 0
    ) {
      const active = this.streamStatus
        ? ACTIVE_STREAM_STATUSES.has(this.streamStatus)
        : false;
      return html`
        <div
          id=${ELEMENT_IDS.LOG_CONTENT}
          class="log-container"
          @scroll=${this.handleScroll}
        >
          <div class="log-placeholder">
            ${active
              ? 'Run is starting. Progress updates will appear here.'
              : 'No log output for this stream yet.'}
          </div>
        </div>
      `;
    }

    if (this.terminal) {
      return html`
        <div
          id=${ELEMENT_IDS.LOG_CONTENT}
          class="log-container"
          @scroll=${this.handleScroll}
        >
          ${this.renderTerminalOutput()}
        </div>
      `;
    }

    // Interleave ungrouped messages (user input, follow-ups, errors) with run
    // groups chronologically so the conversation reads top-to-bottom. The
    // user's original instruction always surfaces at the top because it has
    // the earliest timestamp. Timeline is memoized in willUpdate() — only
    // rebuilt when inputs change.
    return html`
      <div
        id=${ELEMENT_IDS.LOG_CONTENT}
        class="log-container"
        @scroll=${this.handleScroll}
      >
        ${repeat(
          this.cachedTimeline,
          (item) => item.key,
          (item) =>
            'msg' in item
              ? guard([item.msg], () => formatLogEntry(item.msg))
              : this.renderGroupNode(item.tree),
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'task-group-list': TaskGroupList;
  }
}
