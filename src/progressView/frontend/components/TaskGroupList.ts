/**
 * Fully declarative task group list component.
 * Data flows in, DOM flows out. No imperative manipulation.
 *
 * Renders groups, headers, and log entries inline — no intermediate
 * Shadow DOM components. Uses guard() to skip unchanged templates.
 */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { guard } from 'lit/directives/guard.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Local imports - shared schemas
import { STREAM_STATUS } from '@shared/schemas';

// Local imports - shared utilities
import { ToggleStateStore } from '@shared/state/ToggleStateStore';
import { scrollToBottom } from '@shared/utils/dom';
import { getGettingStartedHtml } from '@shared/utils/uiConstants';
import { formatDuration } from '@utils/core';

// Local imports - shared styles
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';

// Local imports - progress view constants
import { ELEMENT_IDS, GROUP_DOM_IDS } from '../constants';

// Local imports - progress view styles
import { logStyles } from '../styles/logStyles';

// Local imports - progress view utils
import { playCompletionSound } from '../utils/audioNotification';

// Local imports - formatters
import { formatLogEntry } from '../formatters';
import { getTimeFormatter } from '../formatters/timestampUtils';

import type { LogMessageData, TaskGroup } from '@shared/schemas';

interface GroupTree {
  group: TaskGroup;
  children: GroupTree[];
  messages: LogMessageData[];
}

const PLACEHOLDER_HTML = getGettingStartedHtml(
  'No runs yet—use TeXRA commands to start. Try ',
);

/** Maps group status to codicon class (with optional animation) */
function getStatusIcon(status: string): string {
  switch (status) {
    case STREAM_STATUS.RUNNING:
      return 'sync spin';
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
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconStyles,
    ...logStyles,
  ];

  /** All task groups to render */
  @property({ attribute: false }) groups: TaskGroup[] = [];

  /** All log messages to render */
  @property({ attribute: false }) messages: LogMessageData[] = [];

  /** Currently visible run ID (null = show all) */
  @property({ attribute: false }) activeRunId: string | null = null;

  /** Whether this is a tool-use session (affects run filtering) */
  @property({ attribute: false }) isToolUse = false;

  /** Whether there are any streams in the current filter (controls placeholder) */
  @property({ attribute: false }) hasStreams = false;

  /** Toggle state store for persistence */
  @property({ attribute: false }) toggleStates: ToggleStateStore | null = null;

  /** Track previous group statuses to detect completion (not rendered — no @state needed) */
  private previousStatuses = new Map<string, string>();

  /** Memoized tree output from buildGroupTree() - recomputed only when inputs change */
  private cachedTree: GroupTree[] = [];
  private cachedUngrouped: LogMessageData[] = [];

  /** O(1) lookup from groupId → tree node. Built during buildGroupTree(). */
  private groupNodeIndex = new Map<string, GroupTree>();

  /** Memoized set of root group IDs for isGroupVisible() */
  private cachedRootGroupIds: Set<string> = new Set();

  /** Reference to the scroll container */
  @query(`#${ELEMENT_IDS.LOG_CONTENT}`)
  private scrollContainer?: HTMLElement;

  /** Public method to scroll to bottom - called by parent LogList */
  scrollToBottom(): void {
    if (this.scrollContainer) {
      scrollToBottom(this.scrollContainer);
    }
  }

  /** Scroll to bottom only when the user is already near the end. */
  scrollToBottomIfNearEnd(threshold = 32): void {
    if (!this.scrollContainer) return;
    if (!this.isNearBottom(threshold)) return;
    scrollToBottom(this.scrollContainer);
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has('groups')) {
      this.checkForCompletedRuns();
    }

    const groupsChanged = changedProperties.has('groups');
    const messagesChanged = changedProperties.has('messages');

    if (groupsChanged) {
      // Structural change — always full rebuild
      [this.cachedTree, this.cachedUngrouped] = this.buildGroupTree();
    } else if (messagesChanged) {
      // Only messages changed — use Lit's old value to pick incremental path
      const prevMessages = changedProperties.get('messages') as
        | LogMessageData[]
        | undefined;
      const prevCount = prevMessages?.length ?? 0;

      if (this.messages.length === prevCount && prevMessages) {
        // Same length: text-only update (e.g. streaming UPDATE_LOG).
        // Propagate fresh message references to cached structures so
        // render() passes updated objects to repeat()/guard().
        this.updateCachedMessageRefs(prevMessages);
      } else if (this.messages.length > prevCount) {
        // Append-only: classify only the new messages incrementally.
        this.appendNewMessages(prevCount);
      } else {
        // Messages shrunk (e.g. clear) — full rebuild
        [this.cachedTree, this.cachedUngrouped] = this.buildGroupTree();
      }
    }

    // Recompute root group IDs when groups or activeRunId change
    if (
      changedProperties.has('groups') ||
      changedProperties.has('activeRunId')
    ) {
      this.cachedRootGroupIds = new Set(
        this.groups.filter((g) => !g.parentGroupId).map((g) => g.id),
      );
    }
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
        node.messages = this.insertMessageSorted(node.messages, msg);
      } else {
        this.cachedUngrouped = this.insertMessageSorted(
          this.cachedUngrouped,
          msg,
        );
      }
    }
  }

  private insertMessageSorted(
    target: LogMessageData[],
    message: LogMessageData,
  ): LogMessageData[] {
    const insertIndex = target.findIndex(
      (entry) => entry.timestamp > message.timestamp,
    );
    if (insertIndex < 0) {
      return [...target, message];
    }
    return [
      ...target.slice(0, insertIndex),
      message,
      ...target.slice(insertIndex),
    ];
  }

  /**
   * Replace stale message references in cached structures with fresh ones.
   *
   * Scans from end (O(1) typical — streaming targets the last message),
   * then uses groupNodeIndex for O(1) node lookup per changed message.
   */
  private updateCachedMessageRefs(prevMessages: LogMessageData[]): void {
    // Find changed entries by comparing refs. Scan from end —
    // streaming target is typically the last message.
    const changed: LogMessageData[] = [];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i] !== prevMessages[i]) {
        changed.push(this.messages[i]);
      }
    }
    if (changed.length === 0) return;

    // Replace each changed message via O(1) groupNodeIndex lookup
    for (const msg of changed) {
      this.replaceSingleMessage(msg);
    }
  }

  /** Replace a single message ref in the cached tree. O(1) node lookup + O(k) findIndex. */
  private replaceSingleMessage(msg: LogMessageData): void {
    // Try group node first (O(1) lookup). A message with groupId may live in
    // cachedUngrouped if the group didn't exist at classification time,
    // so fall through to ungrouped search on miss.
    if (msg.groupId) {
      const node = this.groupNodeIndex.get(msg.groupId);
      if (node) {
        const idx = node.messages.findIndex((m) => m.id === msg.id);
        if (idx >= 0) {
          const updated = [...node.messages];
          updated[idx] = msg;
          node.messages = updated;
          return;
        }
      }
    }

    const idx = this.cachedUngrouped.findIndex((m) => m.id === msg.id);
    if (idx >= 0) {
      const updated = [...this.cachedUngrouped];
      updated[idx] = msg;
      this.cachedUngrouped = updated;
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
   * groupId — the backend (AgentLogger) is responsible for ensuring user
   * messages don't inherit run-group IDs via AsyncLocalStorage.
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

    // Sort messages by timestamp and classify by groupId
    const messageOrder = new Map(
      this.messages.map((message, index) => [message.id, index]),
    );
    const sortedMessages = [...this.messages].sort((a, b) => {
      const aTime = a.timestamp ?? Number.MAX_SAFE_INTEGER;
      const bTime = b.timestamp ?? Number.MAX_SAFE_INTEGER;
      if (aTime !== bTime) return aTime - bTime;
      return (messageOrder.get(a.id) ?? 0) - (messageOrder.get(b.id) ?? 0);
    });
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

    // Get root groups (no parent), sorted by start time
    const groupOrder = new Map(
      this.groups.map((group, index) => [group.id, index]),
    );
    const tree = this.groups
      .filter((g) => !g.parentGroupId)
      .sort((a, b) => {
        const aTime = a.startTime ?? Number.MAX_SAFE_INTEGER;
        const bTime = b.startTime ?? Number.MAX_SAFE_INTEGER;
        if (aTime !== bTime) return aTime - bTime;
        return (groupOrder.get(a.id) ?? 0) - (groupOrder.get(b.id) ?? 0);
      })
      .map(buildNode);

    return [tree, ungrouped];
  }

  /** Check if a root group should be visible */
  private isGroupVisible(groupId: string): boolean {
    // Tool-use: show all groups (conversation turns are append-only)
    if (this.isToolUse) return true;

    // No run selected: show all groups
    if (!this.activeRunId) return true;

    // Fallback: if activeRunId doesn't match any root group, show all
    // This prevents blank content when run IDs are mismatched
    if (!this.cachedRootGroupIds.has(this.activeRunId)) return true;

    // Normal case: only show the selected run
    return groupId === this.activeRunId;
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

  /** Render ungrouped messages as log entries with guard() for change detection */
  private renderUngroupedMessages(messages: LogMessageData[]) {
    if (messages.length === 0) return nothing;
    return repeat(
      messages,
      (m) => m.id,
      (m) => guard([m], () => formatLogEntry(m)),
    );
  }

  /** Render child group header inline (only called for non-root groups) */
  private renderGroupHeader(group: TaskGroup): TemplateResult {
    const formattedStartTime = getTimeFormatter().format(
      new Date(group.startTime),
    );
    const durationText = group.endTime
      ? formatDuration(group.endTime - group.startTime)
      : '';

    return html`
      <span class="group-status-icon">
        <i class="codicon codicon-${getStatusIcon(group.status)}"></i>
      </span>
      <span class="group-title">${group.name}</span>
      <span class="group-time">
        <span class="group-start-time" data-start=${String(group.startTime)}>
          <i class="codicon codicon-clock"></i> ${formattedStartTime}
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

    // Hide root groups that aren't active
    if (!group.parentGroupId && !this.isGroupVisible(group.id)) {
      return nothing;
    }

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

  override render(): TemplateResult {
    // Show placeholder only when there are no streams in the current filter
    if (!this.hasStreams) {
      return html`
        <vscode-scrollable id=${ELEMENT_IDS.LOG_CONTENT} class="log-container">
          <div class="log-placeholder">${unsafeHTML(PLACEHOLDER_HTML)}</div>
        </vscode-scrollable>
      `;
    }

    if (this.isToolUse) {
      // Tool-use: interleave ungrouped messages (user input, errors, etc.)
      // with groups chronologically so the conversation reads top-to-bottom.
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

      return html`
        <vscode-scrollable id=${ELEMENT_IDS.LOG_CONTENT} class="log-container">
          ${repeat(
            timeline,
            (item) => item.key,
            (item) =>
              'msg' in item
                ? guard([item.msg], () => formatLogEntry(item.msg))
                : this.renderGroupNode(item.tree!),
          )}
        </vscode-scrollable>
      `;
    }

    // Workflow: tree first, then all ungrouped messages
    return html`
      <vscode-scrollable id=${ELEMENT_IDS.LOG_CONTENT} class="log-container">
        ${repeat(
          this.cachedTree,
          (t) => t.group.id,
          (t) => this.renderGroupNode(t),
        )}
        ${this.renderUngroupedMessages(this.cachedUngrouped)}
      </vscode-scrollable>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'task-group-list': TaskGroupList;
  }
}
