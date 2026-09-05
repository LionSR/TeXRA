/** Declarative task group list — renders groups, headers, and log entries inline. */

// Third-party imports
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { guard } from 'lit/directives/guard.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared schemas
import {
  GETTING_STARTED_ACTION_PRESENTATION,
  GettingStartedActionSchema,
  STREAM_PHASE,
  type GettingStartedAction,
  type RunOutcome,
  type StreamLifecycleStatus,
  type StreamTabId,
  type TaskGroup,
} from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import { designTokens } from '@shared/styles';
import {
  formatWorkflowPhaseHeading,
  workflowPhaseHeadingOfGroup,
} from '@shared/copy/workflowCall';

// Side-effect imports - register Web Awesome components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

import {
  isInFlightPhase,
  isTerminalOutcomePhase,
} from '@shared/streams/streamStatus';
import { taskGroupDisplayStatus } from '@shared/streams/taskGroupProjection';
import {
  formatRoundStageLabel,
  formatStreamStatusLabel,
} from '@shared/streams/streamStatusDisplay';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { renderEmptyState } from '@shared/wa/emptyState';
import { terminalStatusIcon } from '@shared/wa/statusIcons';
import { compareBySeqNo } from '@shared/streams/streamOrdering';
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
// Side-effect import: registers <terminal-output>, which the terminal-stream
// render path below instantiates.
import './TerminalOutput';
import type { TerminalOutput } from './TerminalOutput';

const DEFAULT_TIMELINE_ITEM_WINDOW = 120;
const TIMELINE_ITEM_WINDOW_STEP = 120;
const DEFAULT_GROUP_ROW_WINDOW = 400;
const GROUP_ROW_WINDOW_STEP = 400;

const taskGroupListStyles = css`
  /* Phase labels may come from workflow plans, so let long or untranslated
     values wrap instead of forcing the status and timestamp off-screen. */
  .group-title {
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .group-time {
    font-variant-numeric: tabular-nums;
  }
`;

interface GroupTree {
  group: TaskGroup;
  children: GroupTree[];
  rows: TranscriptRow[];
}

type TimelineEntry =
  | { key: string; time: number; row: TranscriptRow }
  | { key: string; time: number; tree: GroupTree };

/** Wire append sequence when both rows carry one, wall-clock otherwise. */
function compareRows(a: TranscriptRow, b: TranscriptRow): number {
  return compareBySeqNo(
    a,
    b,
    (row) => row.seqNo,
    (row) => row.timestamp,
  );
}

function compareGroups(a: TaskGroup, b: TaskGroup): number {
  return compareBySeqNo(
    a,
    b,
    () => undefined,
    (group) => group.startTime,
  );
}

/**
 * The transcript as the list renders it: ungrouped rows (the user's
 * inputs, follow-ups, errors) interleaved chronologically with the group
 * trees. Rows are classified by `groupId` alone; a group whose parent is
 * absent is a root.
 */
function transcriptTimeline(
  groups: readonly TaskGroup[],
  rows: readonly TranscriptRow[],
): TimelineEntry[] {
  const groupIds = new Set(groups.map((group) => group.id));
  const children = new Map<string, TaskGroup[]>();
  for (const group of groups) {
    if (!group.parentGroupId || !groupIds.has(group.parentGroupId)) continue;
    const siblings = children.get(group.parentGroupId) ?? [];
    siblings.push(group);
    children.set(group.parentGroupId, siblings);
  }
  const rowsByGroup = new Map<string, TranscriptRow[]>();
  const ungrouped: TranscriptRow[] = [];
  for (const row of rows.toSorted(compareRows)) {
    if (row.groupId && groupIds.has(row.groupId)) {
      const bucket = rowsByGroup.get(row.groupId) ?? [];
      bucket.push(row);
      rowsByGroup.set(row.groupId, bucket);
    } else {
      ungrouped.push(row);
    }
  }
  const node = (group: TaskGroup): GroupTree => ({
    group,
    children: (children.get(group.id) ?? []).sort(compareGroups).map(node),
    rows: rowsByGroup.get(group.id) ?? [],
  });
  const roots = groups
    .filter((g) => !g.parentGroupId || !groupIds.has(g.parentGroupId))
    .sort(compareGroups)
    .map(node);
  return [
    ...ungrouped.map((row) => ({ key: row.id, time: row.timestamp, row })),
    ...roots.map((tree) => ({
      key: tree.group.id,
      time: tree.group.startTime,
      tree,
    })),
  ].sort((a, b) => a.time - b.time);
}

@customElement('task-group-list')
export class TaskGroupList extends LitElement {
  static override styles = [designTokens, ...logStyles, taskGroupListStyles];

  /** All task groups to render */
  @property({ attribute: false }) groups: TaskGroup[] = [];

  /** All transcript rows to render */
  @property({ attribute: false }) rows: TranscriptRow[] = [];

  /** The stream these rows belong to; every group toggle names it. */
  @property({ attribute: false }) streamId: StreamTabId | null = null;

  /** Whether there are any streams in the current filter (controls placeholder) */
  @property({ attribute: false }) hasStreams = false;

  /** Whether the active stream is an interactive tool-use stream. */
  @property({ type: Boolean }) isToolUse = false;

  /** Status for the active stream, used while a run exists before logs arrive. */
  @property({ attribute: false }) streamStatus:
    StreamLifecycleStatus | undefined = undefined;

  /** Whether that status is durably final — terminal with no producer left
   *  anywhere. A group the run never closed paints as interrupted only on
   *  this bit; a terminal phase alone still has a run unwinding behind it. */
  @property({ attribute: false }) streamDurablyFinal = false;

  /** The outcome an unclosed group renders as: the run's own, once nothing
   *  can still close the group. The two properties above are the same pair
   *  the backend resolved together (`StreamMetadata.status` /
   *  `statusDurablyFinal`), so a durably final status is always one of the
   *  three outcomes — and it is the one the host-exit drain would write into
   *  that group's `GROUP_END`. */
  private get runDurableOutcome(): RunOutcome | undefined {
    return this.streamDurablyFinal && isTerminalOutcomePhase(this.streamStatus)
      ? this.streamStatus
      : undefined;
  }

  /** `Surface.groups` for this stream: true is expanded, false collapsed,
   *  a missing key expanded. Toggles go out as surface actions. */
  @property({ attribute: false }) expanded:
    ReadonlyMap<string, boolean> | undefined = undefined;

  /**
   * Render log output in terminal style (monospace, no bullets/timestamps).
   * Reflected to the host attribute so scoped CSS can target it.
   */
  @property({ type: Boolean, reflect: true }) terminal = false;

  /** Track previous group statuses to detect completion (not rendered — no @state needed) */
  private previousStatuses = new Map<string, string>();

  /** The transcript partitioned for render: rebuilt when `groups` or
   *  `rows` change; the rows arrive in wire order and the groups keyed, so
   *  the partition is one pass (PRD 10.2). */
  private timeline: TimelineEntry[] = [];

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
      this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
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

    // The painted status is a fold of the group and the run's durable
    // outcome, so a change in any of the three is a change in what the
    // chime's memory holds: a run that becomes durably final repaints its
    // open groups as its outcome without any group row changing.
    if (
      groupsChanged ||
      changedProperties.has('streamDurablyFinal') ||
      changedProperties.has('streamStatus')
    ) {
      this.checkForCompletedRuns();
    }
    if (this.terminal || !(groupsChanged || rowsChanged)) return;
    this.timeline = transcriptTimeline(this.groups, this.rows);
    // The windows count from the tail; a transcript that shrank (a
    // replaced history) or a fresh mount no longer lines up with them.
    const previousRows = changedProperties.get('rows') as
      TranscriptRow[] | undefined;
    if (
      changedProperties.get('terminal') === true ||
      (previousRows !== undefined && this.rows.length < previousRows.length)
    ) {
      this.resetRenderWindows();
    }
  }

  /**
   * Play the completion sound when a workflow round group leaves `running` for
   * a terminal phase other than `failed`: a finished or cancelled round chimes,
   * a failed one does not.
   */
  private checkForCompletedRuns(): void {
    const nextStatuses = new Map<string, string>();
    for (const group of this.groups) {
      // The status the row PAINTS, not the raw one: a group the run never
      // closed reads as the run's own outcome once nothing can still close
      // it, and the chime's memory has to agree with the pixels or the next
      // paint sees a transition that never happened.
      const status = taskGroupDisplayStatus(group, this.runDurableOutcome);
      const prev = this.previousStatuses.get(group.id);
      const isRunGroup = !this.isToolUse && group.kind === 'round';
      const wasRunning = prev === STREAM_PHASE.RUNNING;
      const isNowComplete =
        status === STREAM_PHASE.COMPLETED || status === STREAM_PHASE.CANCELLED;

      if (isRunGroup && wasRunning && isNowComplete) {
        playCompletionSound();
      }

      nextStatuses.set(group.id, status);
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

  private visibleTimelineEntries(): TimelineEntry[] {
    const timeline = this.timeline;
    return timeline.length <= this.timelineItemWindow
      ? timeline
      : timeline.slice(-this.timelineItemWindow);
  }

  /** Check if a group is expanded */
  private isExpanded(groupId: string): boolean {
    return this.expanded?.get(groupId) !== false;
  }

  private isNearBottom(threshold: number): boolean {
    if (!this.scrollContainer) return false;
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
   * The surface owns the answer: the toggle is dispatched, and the group
   * body follows the `expanded` map the host hands back.
   */
  private handleGroupToggle(event: Event): void {
    if (event.target !== event.currentTarget) return;
    const details = event.currentTarget as HTMLElement;
    const groupId = details.id.slice(GROUP_DOM_IDS.DETAILS_PREFIX.length);
    if (this.streamId === null) return;
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'group',
        streamId: this.streamId,
        key: groupId,
        expanded: event.type === 'wa-show',
      }),
    );
  }

  /** Render child group header inline (only called for non-root groups) */
  private renderGroupHeader(node: GroupTree): TemplateResult {
    const { group } = node;
    const formattedStartTime = getTimeFormatter().format(
      new Date(group.startTime),
    );
    const durationText = group.endTime
      ? formatDuration(group.endTime - group.startTime)
      : '';

    const status = taskGroupDisplayStatus(group, this.runDurableOutcome);
    const statusIcon = terminalStatusIcon(status);
    const title =
      group.kind === 'round' && group.index !== undefined
        ? formatRoundStageLabel({
            index: group.index,
            total: group.total,
          })
        : formatWorkflowPhaseHeading(workflowPhaseHeadingOfGroup(group));
    return html`
      <span class="group-status-icon">
        ${waIcon(statusIcon, {
          label: formatStreamStatusLabel(status),
        })}
      </span>
      <bdi class="group-title">${title}</bdi>
      <span class="group-time">
        <span class="group-start-time">
          ${waIcon('clock')}
          <span class="visually-hidden">Started at </span>
          <time datetime=${new Date(group.startTime).toISOString()}
            >${formattedStartTime}</time
          >
        </span>
        ${
          durationText
            ? html`<span class="group-duration"
                ><span class="visually-hidden">Duration </span
                >${durationText}</span
              >`
            : nothing
        }
      </span>
    `;
  }

  /** Rows of a group followed by its child groups, in transcript order. */
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
    const { group } = node;
    const detailsId = `${GROUP_DOM_IDS.DETAILS_PREFIX}${group.id}`;
    const contentId = `${GROUP_DOM_IDS.CONTENT_PREFIX}${group.id}`;

    // Tree roots: simple container (no collapsible), always render content.
    // Keyed on tree position (isRoot), NOT group.parentGroupId, so a re-rooted
    // orphan — a group whose parent is absent, promoted to a root by
    // `transcriptTimeline` — gets the root layout instead of nested/collapsible
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
            [`is-${taskGroupDisplayStatus(group, this.runDurableOutcome)}`]: true,
          })}
        >
          ${this.renderGroupHeader(node)}
        </div>
        <div id=${contentId} class="log-group-content">
          ${expanded ? this.renderGroupBody(node) : nothing}
        </div>
      </wa-details>
    `;
  }

  /** A process stream's output: its plain log rows, in order, as one text. */
  private renderTerminalOutput(): TemplateResult {
    return html`<terminal-output
      fill
      .text=${this.rows
        .map((row) => (row.kind === 'log' ? row.text.full : ''))
        .join('')}
    ></terminal-output>`;
  }

  private handleGettingStartedAction(action: GettingStartedAction): void {
    this.dispatchEvent(
      SessionUiEvents.host({ kind: 'gettingStarted', action }),
    );
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
    // pane, so show the same "Run is starting" / idle text instead.
    if (this.rows.length === 0 && this.groups.length === 0) {
      const active = isInFlightPhase(this.streamStatus);
      return html`
        <div class="log-placeholder">
          ${
            active
              ? 'Run is starting. Progress updates will appear here.'
              : 'No log output for this run yet.'
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
    const hiddenTimelineCount = this.timeline.length - visibleTimeline.length;

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
        (item) => {
          if ('row' in item) {
            return this.renderLogEntry(item.row);
          }
          return this.renderGroupNode(item.tree, true);
        },
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'task-group-list': TaskGroupList;
  }
}
