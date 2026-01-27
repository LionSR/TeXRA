/**
 * Fully declarative task group list component.
 * Data flows in, DOM flows out. No imperative manipulation.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - side effects: register components
import '@lit-labs/virtualizer';
import './TaskGroupItem';
import './LogEntry';
import './LogPlaceholder';

// Local imports - shared utilities
import { ToggleStateStore } from '@shared/state/ToggleStateStore';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

// Local imports - services
import { AudioNotificationService } from '../services/AudioNotificationService';

// Local imports - shared schemas
import type { LogMessageData, TaskGroup } from '@shared/schemas';

type GroupTree = {
  group: TaskGroup;
  children: GroupTree[];
  messages: LogMessageData[];
};

type TreeBuildResult = {
  tree: GroupTree[];
  ungroupedMessages: LogMessageData[];
};

const PLACEHOLDER_HTML =
  'No runs yet—use TeXRA commands to start. Try ' +
  '<a href="command:texra.openGettingStarted">open the getting started walkthrough</a>, ' +
  '<a href="command:texra.createSampleProject">create a sample project</a>, ' +
  '<a href="command:texra.cloneOverleafProject">clone an Overleaf project</a>, or ' +
  '<a href="command:texra.downloadArXivSource">download an arXiv source</a>.';

@customElement('task-group-list')
export class TaskGroupList extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
  `;

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

  protected override createRenderRoot(): HTMLElement {
    // Use Light DOM for CSS compatibility
    return this;
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
      const wasRunning = prev === 'running';
      const isNowComplete =
        group.status === 'ready' || group.status === 'stopped';

      if (isRunGroup && wasRunning && isNowComplete) {
        AudioNotificationService.playCompletionSound();
      }

      this.previousStatuses.set(group.id, group.status);
    }
  }

  /** Build hierarchical tree from flat groups array */
  private buildGroupTree(): TreeBuildResult {
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

    // Index messages by groupId
    const messagesByGroup = new Map<string, LogMessageData[]>();
    const ungroupedMessages: LogMessageData[] = [];

    for (const msg of this.sortedMessages) {
      if (msg.groupId && groupMap.has(msg.groupId)) {
        const bucket = messagesByGroup.get(msg.groupId) ?? [];
        bucket.push(msg);
        messagesByGroup.set(msg.groupId, bucket);
      } else {
        ungroupedMessages.push(msg);
      }
    }

    // Build tree recursively
    const buildNode = (group: TaskGroup): GroupTree => {
      const children = (childrenMap.get(group.id) ?? [])
        .sort((a, b) => a.startTime - b.startTime)
        .map(buildNode);
      return {
        group,
        children,
        messages: messagesByGroup.get(group.id) ?? [],
      };
    };

    // Get root groups (no parent)
    const rootGroups = this.groups
      .filter((g) => !g.parentGroupId)
      .sort((a, b) => a.startTime - b.startTime);

    return {
      tree: rootGroups.map(buildNode),
      ungroupedMessages,
    };
  }

  /** Get sorted messages */
  private get sortedMessages(): LogMessageData[] {
    return [...this.messages].sort((a, b) => {
      const timeA = a.timestamp ?? 0;
      const timeB = b.timestamp ?? 0;
      return timeA - timeB;
    });
  }

  /** Check if a root group should be visible */
  private isGroupVisible(groupId: string): boolean {
    if (this.isToolUse) return true;
    if (!this.activeRunId) return true;
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
        <lit-virtualizer
          .items=${messages}
          .renderItem=${(m: LogMessageData) =>
            html`<log-entry .message=${m}></log-entry>`}
          .keyFunction=${(m: LogMessageData) => m.id}
        ></lit-virtualizer>
        ${repeat(
          children,
          (c) => c.group.id,
          (c) => this.renderGroupNode(c),
        )}
      </task-group-item>
    `;
  }

  override render(): TemplateResult {
    const { tree, ungroupedMessages } = this.buildGroupTree();

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

    return html`
      <vscode-scrollable id=${ELEMENT_IDS.LOG_CONTENT} class="log-container">
        ${this.isToolUse
          ? html`
              <lit-virtualizer
                .items=${ungroupedMessages}
                .renderItem=${(m: LogMessageData) =>
                  html`<log-entry .message=${m}></log-entry>`}
                .keyFunction=${(m: LogMessageData) => m.id}
              ></lit-virtualizer>
            `
          : nothing}
        ${repeat(
          tree,
          (t) => t.group.id,
          (t) => this.renderGroupNode(t),
        )}
        ${!this.isToolUse
          ? html`
              <lit-virtualizer
                .items=${ungroupedMessages}
                .renderItem=${(m: LogMessageData) =>
                  html`<log-entry .message=${m}></log-entry>`}
                .keyFunction=${(m: LogMessageData) => m.id}
              ></lit-virtualizer>
            `
          : nothing}
      </vscode-scrollable>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'task-group-list': TaskGroupList;
  }
}
