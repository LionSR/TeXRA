/** Declarative task group list — renders groups, headers, and log entries inline. */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { guard } from 'lit/directives/guard.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared schemas
import {
  GETTING_STARTED_ACTION_PRESENTATION,
  GettingStartedActionSchema,
  MESSAGE_TYPES,
  STREAM_PHASE,
  STREAM_STATUS,
  WorkflowCallProgressSchema,
  type GettingStartedAction,
  type LogMessageData,
  type StreamLifecycleStatus,
  type TaskGroup,
} from '@shared/schemas';
import { designTokens } from '@shared/styles';
import {
  formatWorkflowPhaseHeading,
  workflowPhaseCallProgress,
} from '@shared/copy/workflowCall';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';

// Side-effect imports - register Web Awesome components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

import { isInFlightPhase } from '@shared/streams/streamStatus';
import {
  formatRoundStageLabel,
  formatStreamStatusLabel,
} from '@shared/streams/streamStatusDisplay';
import { ToggleStateStore } from '@shared/state/ToggleStateStore';
import { scrollToBottom, vsCodeScrollExtent } from '@shared/utils/dom';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { renderEmptyState } from '@shared/wa/emptyState';
import { formatDuration } from '@utils/core';
import { pluralize } from '@utils/text/stringUtils';

// Local imports - progress view constants
import { ELEMENT_IDS, GROUP_DOM_IDS } from '../constants';

// Local imports - progress view styles
import { logStyles } from '../styles/logStyles';

// Local imports - progress view utils
import { playCompletionSound } from '../audioNotification';

// Local imports - formatters
import { formatLogEntry } from '../formatters';
import { getTimeFormatter } from '../formatters/timestampUtils';

// Local imports - sibling helpers
import { MessageIndex, type GroupTree } from './messageIndex';
import { TerminalBuffer, processTerminalText } from './terminalBuffer';
import { ProgressEvents } from '../events';

const DEFAULT_TIMELINE_ITEM_WINDOW = 120;
const TIMELINE_ITEM_WINDOW_STEP = 120;
const DEFAULT_GROUP_MESSAGE_WINDOW = 400;
const GROUP_MESSAGE_WINDOW_STEP = 400;

/**
 * Maps a group's `StreamPhase`/`RunOutcome` status to a steady wa-icon name.
 * Each terminal phase gets its own icon; an unrecognized status renders as
 * running.
 */
function getStatusIcon(status: string): TeXRAIconName {
  switch (status) {
    case STREAM_PHASE.FAILED:
      return 'circle-exclamation';
    case STREAM_PHASE.COMPLETED:
      return 'check';
    case STREAM_PHASE.CANCELLED:
      return 'circle-stop';
    // Running and every unrecognized status share the plain steady-state
    // circle (running is the default look for a live group).
    default:
      return 'circle';
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
    readonly number[] | null = null;

  /** Generation immediately before updatedMessageIndices was collected. */
  @property({ attribute: false }) updatedMessageBaseGeneration = 0;

  /** Current generation for the messages array. */
  @property({ attribute: false }) messageGeneration = 0;

  /** Whether there are any streams in the current filter (controls placeholder) */
  @property({ attribute: false }) hasStreams = false;

  /** Whether the active stream is an interactive tool-use stream. */
  @property({ type: Boolean }) isToolUse = false;

  /** Status for the active stream, used while a run exists before logs arrive. */
  @property({ attribute: false }) streamStatus: StreamLifecycleStatus | null =
    null;

  /** Toggle state store for persistence */
  @property({ attribute: false }) toggleStates: ToggleStateStore | null = null;

  /**
   * Render log output in terminal style (monospace, no bullets/timestamps).
   * Reflected to the host attribute so scoped CSS can target it.
   */
  @property({ type: Boolean, reflect: true }) terminal = false;

  /** Retained subagent identities used by executions tool cards. */
  @property({ attribute: false })
  subagentExecutionLabels: ExecutionLabels = new Map();

  /** Track previous group statuses to detect completion (not rendered — no @state needed) */
  private previousStatuses = new Map<string, string>();

  private readonly index = new MessageIndex();
  private readonly terminalBuffer = new TerminalBuffer();

  /** Number of recent top-level timeline entries currently rendered. */
  @state() private timelineItemWindow = DEFAULT_TIMELINE_ITEM_WINDOW;

  /** Number of recent message entries rendered for each group. Reassigned
   *  (never mutated in place) so the reactive update cycle picks up changes. */
  @state() private groupMessageWindows = new Map<string, number>();

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
    const groupsChanged = changedProperties.has('groups');
    const messagesChanged = changedProperties.has('messages');

    if (groupsChanged) {
      this.checkForCompletedRuns();
    }

    if (this.terminal) {
      const fullText = (): string => this.messages.map((m) => m.text).join('');
      const prevMsgs = changedProperties.get('messages') as
        LogMessageData[] | undefined;
      const prevCount = prevMsgs?.length ?? 0;
      if (changedProperties.has('terminal')) {
        this.terminalBuffer.rebuild(fullText());
      } else if (messagesChanged && this.messages.length > prevCount) {
        this.terminalBuffer.append(
          this.messages
            .slice(prevCount)
            .map((m) => m.text)
            .join(''),
        );
      } else if (messagesChanged) {
        this.terminalBuffer.rebuild(fullText());
      }
    }

    const renderWindowsStale = this.index.apply({
      terminal: this.terminal,
      wasTerminal: changedProperties.get('terminal') === true,
      groups: this.groups,
      previousGroups: changedProperties.get('groups') as
        TaskGroup[] | undefined,
      groupsChanged,
      messages: this.messages,
      previousMessages: changedProperties.get('messages') as
        LogMessageData[] | undefined,
      messagesChanged,
      deltaIndices: this.canUseUpdatedMessageIndices()
        ? (this.updatedMessageIndices ?? [])
        : null,
    });
    if (renderWindowsStale) {
      this.resetRenderWindows();
    }
  }

  override updated(): void {
    this.processedMessageGeneration = this.messageGeneration;

    if (this.terminal) {
      if (this.terminalCommittedPre) {
        this.terminalBuffer.sync(this.terminalCommittedPre);
      }
      return;
    }

    this.terminalBuffer.resetDomState();
  }

  private canUseUpdatedMessageIndices(): boolean {
    return (
      this.updatedMessageIndices !== null &&
      this.updatedMessageBaseGeneration === this.processedMessageGeneration
    );
  }

  /**
   * Play the completion sound when a workflow round group leaves `running` for
   * a terminal phase other than `failed`: a finished or cancelled round chimes,
   * a failed one does not.
   */
  private checkForCompletedRuns(): void {
    const nextStatuses = new Map<string, string>();
    for (const group of this.groups) {
      const prev = this.previousStatuses.get(group.id);
      const isRunGroup = !this.isToolUse && group.kind === 'round';
      const wasRunning = prev === STREAM_PHASE.RUNNING;
      const isNowComplete =
        group.status === STREAM_PHASE.COMPLETED ||
        group.status === STREAM_PHASE.CANCELLED;

      if (isRunGroup && wasRunning && isNowComplete) {
        playCompletionSound();
      }

      nextStatuses.set(group.id, group.status);
    }
    this.previousStatuses = nextStatuses;
  }

  private resetRenderWindows(): void {
    this.timelineItemWindow = DEFAULT_TIMELINE_ITEM_WINDOW;
    this.groupMessageWindows = new Map();
  }

  private renderRevealButton(options: {
    hiddenCount: number;
    step: number;
    scope: string;
    kind: 'timeline' | 'messages';
    label: string;
  }): TemplateResult {
    const revealCount = Math.min(options.hiddenCount, options.step);
    const suffix = pluralize(revealCount, options.label);
    return html`
      <div class="log-reveal-row">
        <wa-button
          appearance="outlined"
          size="s"
          data-reveal-kind=${options.kind}
          data-reveal-scope=${options.scope}
          data-hidden-count=${String(options.hiddenCount)}
          @click=${this.handleRevealOlderRows}
          aria-label=${`Show ${revealCount} older ${suffix}`}
          >${waIcon('chevron-up', { slot: 'start' })} Show ${revealCount} older
          ${suffix}</wa-button
        >
      </div>
    `;
  }

  private renderMessageEntries(
    messages: readonly LogMessageData[],
    scope: string,
  ): TemplateResult {
    const windowSize =
      this.groupMessageWindows.get(scope) ?? DEFAULT_GROUP_MESSAGE_WINDOW;
    const hiddenCount = Math.max(0, messages.length - windowSize);
    const visibleMessages =
      hiddenCount > 0 ? messages.slice(hiddenCount) : messages;

    return html`${
      hiddenCount > 0
        ? this.renderRevealButton({
            hiddenCount,
            step: GROUP_MESSAGE_WINDOW_STEP,
            scope,
            kind: 'messages',
            label: 'message',
          })
        : nothing
    }${repeat(
      visibleMessages,
      (m) => m.id,
      (m) => this.renderLogEntry(m),
    )}`;
  }

  /**
   * Format one log message, guarded against re-render while it and the
   * current subagent labels stay the same.
   */
  private renderLogEntry(message: LogMessageData) {
    return guard([message, this.subagentExecutionLabels], () =>
      formatLogEntry(message, {
        executionLabels: this.subagentExecutionLabels,
      }),
    );
  }

  private handleRevealOlderRows(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    const kind = target.dataset.revealKind;
    const scope = target.dataset.revealScope;
    if (!scope) return;

    if (kind === 'timeline') {
      this.timelineItemWindow += TIMELINE_ITEM_WINDOW_STEP;
    } else if (kind === 'messages') {
      const current =
        this.groupMessageWindows.get(scope) ?? DEFAULT_GROUP_MESSAGE_WINDOW;
      this.groupMessageWindows = new Map(this.groupMessageWindows).set(
        scope,
        current + GROUP_MESSAGE_WINDOW_STEP,
      );
    }
  }

  private visibleTimelineEntries(): typeof this.index.timeline {
    const timeline = this.index.timeline;
    return timeline.length <= this.timelineItemWindow
      ? timeline
      : timeline.slice(-this.timelineItemWindow);
  }

  /** Check if a group is expanded */
  private isExpanded(groupId: string): boolean {
    if (!this.toggleStates) return true;
    return this.toggleStates.get(groupId) !== true;
  }

  private isNearBottom(threshold: number): boolean {
    if (!this.scrollContainer) return false;
    const vs = vsCodeScrollExtent(this.scrollContainer);
    if (vs) return vs.max - vs.pos <= threshold;
    const remaining =
      this.scrollContainer.scrollHeight -
      this.scrollContainer.scrollTop -
      this.scrollContainer.clientHeight;
    return remaining <= threshold;
  }

  /**
   * Handle a group's open/close — wired to both wa-show and wa-hide. Those
   * events BUBBLE (unlike the native <details> `toggle`), so nested child
   * groups would otherwise re-trigger their ancestors — guard on
   * target === currentTarget. Open state comes from the event type; groupId
   * from the element ID (no per-row closures). Lit binds the host as `this`.
   */
  private handleGroupToggle(event: Event): void {
    if (event.target !== event.currentTarget) return;
    const details = event.currentTarget as HTMLElement;
    const groupId = details.id.slice(GROUP_DOM_IDS.DETAILS_PREFIX.length);
    if (this.toggleStates) {
      // toggleStates stores `true` = collapsed; wa-show means now-open.
      this.toggleStates.set(groupId, event.type !== 'wa-show');
    }
    // Re-render to add/remove children from the DOM (lazy collapsed groups)
    this.requestUpdate();
  }

  /**
   * `done/total` for a phase header, folded from the workflow-call cards the
   * group already holds. A malformed row drops out (safeParse), matching how
   * the card formatter guards itself. Nothing renders for a group with no
   * call cards, so round and run headers are unaffected.
   */
  private renderGroupProgress(
    group: TaskGroup,
    messages: readonly LogMessageData[],
  ): TemplateResult | typeof nothing {
    if (group.kind !== 'phase') return nothing;
    const calls = messages.flatMap((message) => {
      if (message.messageType !== MESSAGE_TYPES.WORKFLOW_TASK) return [];
      const parsed = WorkflowCallProgressSchema.safeParse(message.data);
      return parsed.success ? [parsed.data] : [];
    });
    const { done, total } = workflowPhaseCallProgress(calls);
    if (total === 0) return nothing;
    return html`<span class="group-progress">${done}/${total}</span>`;
  }

  /** Render child group header inline (only called for non-root groups) */
  private renderGroupHeader(
    group: TaskGroup,
    messages: readonly LogMessageData[],
  ): TemplateResult {
    const formattedStartTime = getTimeFormatter().format(
      new Date(group.startTime),
    );
    const durationText = group.endTime
      ? formatDuration(group.endTime - group.startTime)
      : '';

    const statusIcon = getStatusIcon(group.status);
    const title =
      group.kind === 'round' && group.index !== undefined
        ? formatRoundStageLabel({
            index: group.index,
            total: group.total,
          })
        : formatWorkflowPhaseHeading({
            phaseLabel: group.name,
            phaseIndex: group.index,
            phaseTotal: group.total,
          });
    return html`
      <span class="group-status-icon">
        ${waIcon(statusIcon, {
          label: formatStreamStatusLabel(group.status),
        })}
      </span>
      <span class="group-title">${title}</span>
      ${this.renderGroupProgress(group, messages)}
      <span class="group-time">
        <span class="group-start-time" data-start=${String(group.startTime)}>
          ${waIcon('clock')} ${formattedStartTime}
        </span>
        ${
          durationText
            ? html`<span class="group-duration">${durationText}</span>`
            : nothing
        }
      </span>
    `;
  }

  /** Messages of a group followed by its child groups. */
  private renderGroupBody(node: GroupTree): TemplateResult {
    return html`${this.renderMessageEntries(
      node.messages,
      `group:${node.group.id}`,
    )}${repeat(
      node.children,
      (c) => c.group.id,
      (c) => this.renderGroupNode(c),
    )}`;
  }

  /** Render a group node and its children recursively */
  private renderGroupNode(
    node: GroupTree,
    isRoot = false,
  ): TemplateResult | typeof nothing {
    const { group, messages } = node;
    const detailsId = `${GROUP_DOM_IDS.DETAILS_PREFIX}${group.id}`;
    const contentId = `${GROUP_DOM_IDS.CONTENT_PREFIX}${group.id}`;

    // Tree roots: simple container (no collapsible), always render content.
    // Keyed on tree position (isRoot), NOT group.parentGroupId, so a re-rooted
    // orphan — a group whose parent is absent, promoted to a root by
    // messageIndex (R2) — gets the root layout instead of nested/collapsible
    // even though it retains its dangling parentGroupId.
    if (isRoot) {
      return html`
        <div id=${detailsId} class="log-group log-run" data-run-id=${group.id}>
          <div id=${contentId} class="log-group-content">
            ${this.renderGroupBody(node)}
          </div>
        </div>
      `;
    }

    // Child groups: collapsible details element.
    // Collapsed child groups contribute zero DOM nodes for their content.
    const expanded = this.isExpanded(group.id);

    return html`
      <wa-details
        id=${detailsId}
        class="log-group"
        ?open=${expanded}
        @wa-show=${this.handleGroupToggle}
        @wa-hide=${this.handleGroupToggle}
      >
        <div
          slot="summary"
          id="${GROUP_DOM_IDS.HEADER_PREFIX}${group.id}"
          class=${classMap({
            'log-group-header': true,
            [`is-${group.status}`]: true,
          })}
        >
          ${this.renderGroupHeader(group, messages)}
        </div>
        <div id=${contentId} class="log-group-content">
          ${expanded ? this.renderGroupBody(node) : nothing}
        </div>
      </wa-details>
    `;
  }

  private renderTerminalOutput(): TemplateResult {
    const tailText = processTerminalText(this.terminalBuffer.tail);
    // Single-line templates: a wrapped `<pre>` would put the reflowed
    // whitespace inside the preformatted block.
    const committedClass = 'terminal-pre terminal-pre--committed';
    const tailClass = 'terminal-pre terminal-pre--tail';
    const committed = html`<pre class=${committedClass}></pre>`;
    const tail = html`<pre class=${tailClass}>${tailText}</pre>`;
    return html`<div class="terminal-container">${[committed, tail]}</div>`;
  }

  private handleGettingStartedAction(action: GettingStartedAction): void {
    this.dispatchEvent(ProgressEvents.gettingStartedAction({ action }));
  }

  override render(): TemplateResult {
    return html`
      <div
        id=${ELEMENT_IDS.LOG_CONTENT}
        class="log-container"
        @scroll=${this.handleScroll}
      >
        ${this.renderLogContent()}
      </div>
    `;
  }

  private renderLogContent(): TemplateResult {
    // Show placeholder only when there are no streams in the current filter
    if (!this.hasStreams) {
      return renderEmptyState({
        icon: 'terminal',
        title: 'No runs yet',
        body: 'Start an agent from the New tab or Commands.',
        headingTag: 'h3',
        className: 'log-placeholder',
        actions: GettingStartedActionSchema.options.map((action) => ({
          ...GETTING_STARTED_ACTION_PRESENTATION[action],
          size: 's' as const,
          onClick: () => this.handleGettingStartedAction(action),
        })),
      });
    }

    // Pre-output placeholder, including terminal-mode (process-agent) streams:
    // with no messages the terminal buffer is empty and would render a blank
    // <pre>, so show the same "Run is starting" / idle text instead.
    if (this.messages.length === 0 && this.groups.length === 0) {
      const active =
        this.streamStatus !== STREAM_STATUS.READY &&
        isInFlightPhase(this.streamStatus ?? undefined);
      return html`
        <div class="log-placeholder">
          ${
            active
              ? 'Run is starting. Progress updates will appear here.'
              : 'No log output for this stream yet.'
          }
        </div>
      `;
    }

    if (this.terminal) {
      return this.renderTerminalOutput();
    }

    // Interleave ungrouped messages (user input, follow-ups, errors) with run
    // groups chronologically so the conversation reads top-to-bottom. Large
    // streams render a recent window first; older timeline entries remain in
    // memory and can be revealed from the top control.
    const visibleTimeline = this.visibleTimelineEntries();
    const hiddenTimelineCount =
      this.index.timeline.length - visibleTimeline.length;

    return html`
      ${
        hiddenTimelineCount > 0
          ? this.renderRevealButton({
              hiddenCount: hiddenTimelineCount,
              step: TIMELINE_ITEM_WINDOW_STEP,
              scope: 'timeline',
              kind: 'timeline',
              label: 'item',
            })
          : nothing
      }
      ${repeat(
        visibleTimeline,
        (item) => item.key,
        (item) =>
          'msg' in item
            ? this.renderLogEntry(item.msg)
            : this.renderGroupNode(item.tree, true),
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'task-group-list': TaskGroupList;
  }
}
