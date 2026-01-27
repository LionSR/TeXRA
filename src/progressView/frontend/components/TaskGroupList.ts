/**
 * Fully declarative task group list component.
 * Data flows in, DOM flows out. No imperative manipulation.
 *
 * Uses Shadow DOM with modular styles for encapsulation.
 */

// Third-party imports
import { LitElement, html, type TemplateResult, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - side effects: register components
import './TaskGroupItem';
import './LogEntry';
import './LogPlaceholder';

// Local imports - shared schemas
import { STREAM_STATUS } from '@shared/schemas';

// Local imports - shared utilities
import { ToggleStateStore } from '@shared/state/ToggleStateStore';
import { scrollToBottom } from '@shared/utils/dom';
import { getGettingStartedHtml } from '@shared/utils/uiConstants';

// Local imports - shared styles
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

// Local imports - progress view styles
import { logStyles } from '../styles/logStyles';

// Local imports - progress view utils
import { playCompletionSound } from '../utils/audioNotification';

import type { LogMessageData, TaskGroup } from '@shared/schemas';

interface GroupTree {
  group: TaskGroup;
  children: GroupTree[];
  messages: LogMessageData[];
}

const PLACEHOLDER_HTML = getGettingStartedHtml(
  'No runs yet—use TeXRA commands to start. Try ',
);

@customElement('task-group-list')
export class TaskGroupList extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconStyles,
    ...logStyles,
  ];

  /** All task groups to render */
  @property({ type: Array }) groups: TaskGroup[] = [];

  /** All log messages to render */
  @property({ type: Array }) messages: LogMessageData[] = [];

  /** Currently visible run ID (null = show all) */
  @property({ type: String }) activeRunId: string | null = null;

  /** Whether this is a tool-use session (affects run filtering) */
  @property({ type: Boolean }) isToolUse = false;

  /** Toggle state store for persistence */
  @property({ type: Object }) toggleStates: ToggleStateStore | null = null;

  /** Track previous group statuses to detect completion */
  @state() private previousStatuses = new Map<string, string>();

  /** Reference to the scroll container */
  @query(`#${ELEMENT_IDS.LOG_CONTENT}`)
  private scrollContainer?: HTMLElement;

  /** Public method to scroll to bottom - called by parent LogList */
  scrollToBottom(): void {
    if (this.scrollContainer) {
      scrollToBottom(this.scrollContainer);
    }
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has('groups')) {
      this.checkForCompletedRuns();
    }
  }

  /** Play sound when a run group completes */
  private checkForCompletedRuns(): void {
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

      this.previousStatuses.set(group.id, group.status);
    }
  }

  /**
   * Build hierarchical tree from flat groups array.
   * Returns [tree, ungroupedMessages] tuple.
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

    // Sort messages by timestamp and index by groupId
    const sortedMessages = [...this.messages].sort(
      (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
    );
    const messagesByGroup = new Map<string, LogMessageData[]>();
    const ungroupedMessages: LogMessageData[] = [];

    for (const msg of sortedMessages) {
      if (msg.groupId && groupMap.has(msg.groupId)) {
        const bucket = messagesByGroup.get(msg.groupId) ?? [];
        bucket.push(msg);
        messagesByGroup.set(msg.groupId, bucket);
      } else {
        ungroupedMessages.push(msg);
      }
    }

    // Build tree recursively
    function buildNode(group: TaskGroup): GroupTree {
      return {
        group,
        children: (childrenMap.get(group.id) ?? [])
          .sort((a, b) => a.startTime - b.startTime)
          .map(buildNode),
        messages: messagesByGroup.get(group.id) ?? [],
      };
    }

    // Get root groups (no parent), sorted by start time
    const tree = this.groups
      .filter((g) => !g.parentGroupId)
      .sort((a, b) => a.startTime - b.startTime)
      .map(buildNode);

    return [tree, ungroupedMessages];
  }

  /** Check if a root group should be visible */
  private isGroupVisible(groupId: string): boolean {
    // Tool-use: show all groups (conversation turns are append-only)
    if (this.isToolUse) return true;

    // No run selected: show all groups
    if (!this.activeRunId) return true;

    // Fallback: if activeRunId doesn't match any root group, show all
    // This prevents blank content when run IDs are mismatched
    const rootGroupIds = new Set(
      this.groups.filter((g) => !g.parentGroupId).map((g) => g.id),
    );
    if (!rootGroupIds.has(this.activeRunId)) return true;

    // Normal case: only show the selected run
    return groupId === this.activeRunId;
  }

  /** Check if a group is expanded */
  private isExpanded(groupId: string): boolean {
    if (!this.toggleStates) return true;
    return this.toggleStates.get(groupId) !== true;
  }

  /** Handle group toggle events */
  private handleGroupToggle(
    event: CustomEvent<{ groupId: string; expanded: boolean }>,
  ): void {
    const { groupId, expanded } = event.detail;
    if (this.toggleStates) {
      this.toggleStates.set(groupId, !expanded);
    }
  }

  /** Render ungrouped messages as log entries */
  private renderUngroupedMessages(messages: LogMessageData[]) {
    if (messages.length === 0) return nothing;
    return repeat(
      messages,
      (m) => m.id,
      (m) => html`<log-entry .message=${m}></log-entry>`,
    );
  }

  /** Render a group node and its children recursively */
  private renderGroupNode(node: GroupTree): TemplateResult | typeof nothing {
    const { group, children, messages } = node;

    // Hide root groups that aren't active
    if (!group.parentGroupId && !this.isGroupVisible(group.id)) {
      return nothing;
    }

    return html`
      <task-group-item
        .group=${group}
        ?expanded=${this.isExpanded(group.id)}
        @group-toggle=${this.handleGroupToggle}
      >
        ${repeat(
          messages,
          (m) => m.id,
          (m) => html`<log-entry .message=${m}></log-entry>`,
        )}
        ${repeat(
          children,
          (c) => c.group.id,
          (c) => this.renderGroupNode(c),
        )}
      </task-group-item>
    `;
  }

  override render(): TemplateResult {
    const [tree, ungroupedMessages] = this.buildGroupTree();

    // Show placeholder if empty
    if (tree.length === 0 && this.messages.length === 0) {
      return html`
        <vscode-scrollable id=${ELEMENT_IDS.LOG_CONTENT} class="log-container">
          <log-placeholder
            id=${ELEMENT_IDS.LOG_PLACEHOLDER}
            .content=${PLACEHOLDER_HTML}
          ></log-placeholder>
        </vscode-scrollable>
      `;
    }

    // Tool-use: ungrouped messages first, then tree
    // Workflow: tree first, then ungrouped messages
    const [ungroupedBefore, ungroupedAfter] = this.isToolUse
      ? [ungroupedMessages, []]
      : [[], ungroupedMessages];

    return html`
      <vscode-scrollable id=${ELEMENT_IDS.LOG_CONTENT} class="log-container">
        ${this.renderUngroupedMessages(ungroupedBefore)}
        ${repeat(
          tree,
          (t) => t.group.id,
          (t) => this.renderGroupNode(t),
        )}
        ${this.renderUngroupedMessages(ungroupedAfter)}
      </vscode-scrollable>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'task-group-list': TaskGroupList;
  }
}
