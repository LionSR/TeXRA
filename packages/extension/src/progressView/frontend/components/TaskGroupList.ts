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
  STREAM_PHASE,
  STREAM_STATUS,
  type GettingStartedAction,
  type StreamLifecycleStatus,
  type StreamLogEntry,
  type TaskGroup,
} from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import { designTokens } from '@shared/styles';
import {
  formatWorkflowPhaseHeading,
  workflowPhaseCallProgress,
} from '@shared/copy/workflowCall';

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
import { terminalStatusIcon } from '@shared/wa/statusIcons';
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
import { TranscriptIndex, type GroupTree } from './messageIndex';
// Side-effect import: registers <terminal-output>, which the terminal-stream
// render path below instantiates.
import './TerminalOutput';
import { ProgressEvents } from '../events';
import type { TerminalOutput } from './TerminalOutput';

const DEFAULT_TIMELINE_ITEM_WINDOW = 120;
const TIMELINE_ITEM_WINDOW_STEP = 120;
const DEFAULT_GROUP_ROW_WINDOW = 400;
const GROUP_ROW_WINDOW_STEP = 400;

/**
 * Maps a group's `StreamPhase`/`RunOutcome` status to a steady wa-icon name.
 * Each terminal phase gets its own icon; an unrecognized status renders as
 * running.
 */
function getStatusIcon(status: string): TeXRAIconName {
  switch (status) {
    case STREAM_PHASE.FAILED:
      return terminalStatusIcon('failed');
    case STREAM_PHASE.COMPLETED:
      return terminalStatusIcon('completed');
    case STREAM_PHASE.CANCELLED:
      return terminalStatusIcon('cancelled');
    // Running and every unrecognized status share the plain steady-state
    // circle (running is the default look for a live group).
    default:
      return terminalStatusIcon('running');
  }
}

@customElement('task-group-list')
export class TaskGroupList extends LitElement {
  static override styles = [designTokens, ...logStyles];

  /** All task groups to render */
  @property({ attribute: false }) groups: TaskGroup[] = [];

  /** All transcript rows to render */
  @property({ attribute: false }) rows: TranscriptRow[] = [];

  /**
   * Source log entries. Read only by the terminal render path, which shows a
   * process stream's raw output text rather than transcript rows.
   */
  @property({ attribute: false }) entries: StreamLogEntry[] = [];

  /**
   * Existing row indices updated by the most recent backend delta.
   * Null means the producer did not provide delta metadata, so fall back
   * to reference scans.
   */
  @property({ attribute: false }) updatedRowIndices: readonly number[] | null =
    null;

  /** Generation immediately before updatedRowIndices was collected. */
  @property({ attribute: false }) updatedRowBaseGeneration = 0;

  /** Current generation for the rows array. */
  @property({ attribute: false }) rowGeneration = 0;

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

  /** Track previous group statuses to detect completion (not rendered — no @state needed) */
  private previousStatuses = new Map<string, string>();

  private readonly index = new TranscriptIndex();

  /** Number of recent top-level timeline entries currently rendered. */
  @state() private timelineItemWindow = DEFAULT_TIMELINE_ITEM_WINDOW;

  /** Number of recent rows rendered for each group. Reassigned
   *  (never mutated in place) so the reactive update cycle picks up changes. */
  @state() private groupRowWindows = new Map<string, number>();

  /** Reference to the scroll container */
  @query(`#${ELEMENT_IDS.LOG_CONTENT}`)
  private scrollContainer?: HTMLElement;

  /** xterm renderer for terminal-mode streams; owns its own viewport. */
  @query('terminal-output')
  private terminalOutput?: TerminalOutput;

  /**
   * Sticky scroll state: when true, new content auto-scrolls to bottom.
   * Flips false when user scrolls away, true when user scrolls back to bottom.
   */
  private isSticky = true;

  /** Threshold for detecting "near bottom" in scroll listener (px) */
  private static readonly STICKY_THRESHOLD = 150;

  /** Row generation represented by the current cached tree/timeline. */
  private processedRowGeneration = 0;

  /** Handle native scroll events from the log container to track user intent */
  private handleScroll = (): void => {
    this.isSticky = this.isNearBottom(TaskGroupList.STICKY_THRESHOLD);
  };

  /** Public method to scroll to bottom - called by parent LogList */
  scrollToBottom(): void {
    if (this.terminal) {
      // xterm owns the viewport for terminal streams. LogList calls this on a
      // tab switch, which is also the first moment this tree is unhidden and
      // can measure itself — every fit attempted while hidden was skipped.
      this.terminalOutput?.refitIfVisible();
      this.terminalOutput?.scrollToBottom();
      return;
    }
    if (this.scrollContainer) {
      scrollToBottom(this.scrollContainer);
    }
  }

  /** Scroll to bottom only when sticky (user hasn't scrolled away). */
  scrollToBottomIfSticky(): void {
    // Terminal streams: the terminal keeps its own viewport pinned unless the
    // user scrolled away inside it, and the outer container never overflows,
    // so there is nothing here to follow.
    if (this.terminal) return;
    if (!this.isSticky) return;
    this.scrollToBottom();
  }

  /** Force sticky state — called by parent on tab switch */
  setSticky(value: boolean): void {
    this.isSticky = value;
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    const groupsChanged = changedProperties.has('groups');
    const rowsChanged = changedProperties.has('rows');

    if (groupsChanged) {
      this.checkForCompletedRuns();
    }

    const renderWindowsStale = this.index.apply({
      terminal: this.terminal,
      wasTerminal: changedProperties.get('terminal') === true,
      groups: this.groups,
      previousGroups: changedProperties.get('groups') as
        TaskGroup[] | undefined,
      groupsChanged,
      rows: this.rows,
      previousRows: changedProperties.get('rows') as
        TranscriptRow[] | undefined,
      rowsChanged,
      deltaIndices: this.canUseUpdatedRowIndices()
        ? (this.updatedRowIndices ?? [])
        : null,
    });
    if (renderWindowsStale) {
      this.resetRenderWindows();
    }
  }

  override updated(): void {
    this.processedRowGeneration = this.rowGeneration;
  }

  private canUseUpdatedRowIndices(): boolean {
    return (
      this.updatedRowIndices !== null &&
      this.updatedRowBaseGeneration === this.processedRowGeneration
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
    this.groupRowWindows = new Map();
  }

  private renderRevealButton(options: {
    hiddenCount: number;
    step: number;
    scope: string;
    kind: 'timeline' | 'rows';
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

  private renderRowEntries(
    rows: readonly TranscriptRow[],
    scope: string,
  ): TemplateResult {
    const windowSize =
      this.groupRowWindows.get(scope) ?? DEFAULT_GROUP_ROW_WINDOW;
    const hiddenCount = Math.max(0, rows.length - windowSize);
    const visibleRows = hiddenCount > 0 ? rows.slice(hiddenCount) : rows;

    return html`${
      hiddenCount > 0
        ? this.renderRevealButton({
            hiddenCount,
            step: GROUP_ROW_WINDOW_STEP,
            scope,
            kind: 'rows',
            label: 'message',
          })
        : nothing
    }${repeat(
      visibleRows,
      (row) => row.id,
      (row) => this.renderLogEntry(row),
    )}`;
  }

  /**
   * Paint one transcript row, guarded against re-render while the row stays
   * the same object. A row is replaced (never patched) whenever its source
   * entry changes, so reference identity is the whole freshness test.
   */
  private renderLogEntry(row: TranscriptRow) {
    return guard([row], () => formatLogEntry(row));
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
    } else if (kind === 'rows') {
      const current =
        this.groupRowWindows.get(scope) ?? DEFAULT_GROUP_ROW_WINDOW;
      this.groupRowWindows = new Map(this.groupRowWindows).set(
        scope,
        current + GROUP_ROW_WINDOW_STEP,
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
   * group already holds. Nothing renders for a group with no call cards, so
   * round and run headers are unaffected.
   */
  private renderGroupProgress(
    group: TaskGroup,
    rows: readonly TranscriptRow[],
  ): TemplateResult | typeof nothing {
    if (group.kind !== 'phase') return nothing;
    const calls = rows.flatMap((row) =>
      row.kind === 'workflowTask' ? [row.call] : [],
    );
    const { done, total } = workflowPhaseCallProgress(calls);
    if (total === 0) return nothing;
    return html`<span class="group-progress">${done}/${total}</span>`;
  }

  /** Render child group header inline (only called for non-root groups) */
  private renderGroupHeader(
    group: TaskGroup,
    rows: readonly TranscriptRow[],
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
      ${this.renderGroupProgress(group, rows)}
      <span class="group-time">
        <span class="group-start-time">
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

  /** Rows of a group followed by its child groups. */
  private renderGroupBody(node: GroupTree): TemplateResult {
    return html`${this.renderRowEntries(
      node.rows,
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
    const { group, rows } = node;
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
          ${this.renderGroupHeader(group, rows)}
        </div>
        <div id=${contentId} class="log-group-content">
          ${expanded ? this.renderGroupBody(node) : nothing}
        </div>
      </wa-details>
    `;
  }

  private renderTerminalOutput(): TemplateResult {
    return html`<terminal-output
      fill
      .text=${this.entries.map((entry) => entry.text ?? '').join('')}
    ></terminal-output>`;
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
    // with no output the terminal buffer is empty and would render a blank
    // <pre>, so show the same "Run is starting" / idle text instead.
    if (
      this.rows.length === 0 &&
      this.entries.length === 0 &&
      this.groups.length === 0
    ) {
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

    // Interleave ungrouped rows (user input, follow-ups, errors) with run
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
          'row' in item
            ? this.renderLogEntry(item.row)
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
