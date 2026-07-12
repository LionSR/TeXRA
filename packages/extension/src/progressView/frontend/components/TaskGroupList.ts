/** Declarative task group list — renders groups, headers, and log entries inline. */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { guard } from 'lit/directives/guard.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - stream state
import { isInFlightPhase } from '@common/constants/streamStatus';

// Local imports - shared schemas
import {
  STREAM_PHASE,
  StreamPhaseSchema,
  type GettingStartedAction,
  type LogMessageData,
  type TaskGroup,
} from '@shared/schemas';

// Side-effect imports - register WA icon and spinner components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';

import { designTokens } from '@shared/styles';
import { parseWorkflowOutputRoundDir } from '@shared/constants/workflowOutput';
import { ToggleStateStore } from '@shared/state/ToggleStateStore';
import { scrollToBottom } from '@shared/utils/dom';
import { TEXRA_ICON_LIBRARY, waIcon } from '@shared/wa/webAwesomeIcons';
import { renderEmptyState } from '@shared/wa/emptyState';
import { formatDuration } from '@utils/core';

// Local imports - progress view constants
import { ELEMENT_IDS, GROUP_DOM_IDS } from '../constants';

// Local imports - progress view styles
import { logStyles } from '../styles/logStyles';

// Local imports - progress view utils
import { playCompletionSound } from '../utils/audioNotification';

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
 * Maps group status to a wa-icon name; null indicates an animated spinner.
 * `TaskGroup.status` is the native `StreamPhase`/`RunOutcome` vocabulary
 * (#7993 step 3) — `CANCELLED` now renders distinctly from `COMPLETED`
 * instead of folding into one neutral "stopped" icon.
 */
function getStatusIcon(status: string): string | null {
  switch (status) {
    case STREAM_PHASE.RUNNING:
      return null;
    case STREAM_PHASE.FAILED:
      return 'error';
    case STREAM_PHASE.COMPLETED:
      return 'check';
    case STREAM_PHASE.CANCELLED:
      return 'circle-stop';
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
    if (changedProperties.has('groups')) {
      this.checkForCompletedRuns();
    }

    const groupsChanged = changedProperties.has('groups');
    const messagesChanged = changedProperties.has('messages');

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

    // Group tree, message classification, and timeline are only used by the
    // non-terminal render path — skip them when terminal mode is active.
    if (this.terminal) return;

    // If terminal just switched off, caches weren't maintained while it was on —
    // do a full rebuild so the non-terminal render has accurate data.
    if (changedProperties.get('terminal') === true) {
      this.index.rebuildTree(this.groups, this.messages);
      this.index.rebuildTimeline();
      this.resetRenderWindows();
      return;
    }

    const prevGroups = groupsChanged
      ? (changedProperties.get('groups') as TaskGroup[] | undefined)
      : undefined;
    const patchedGroupMetadata =
      groupsChanged && prevGroups
        ? this.index.patchGroupMetadataIfShapeStable(prevGroups, this.groups)
        : false;

    const prevMessages = messagesChanged
      ? (changedProperties.get('messages') as LogMessageData[] | undefined)
      : undefined;
    const prevCount = prevMessages?.length ?? 0;
    const deltaIndices = this.canUseUpdatedMessageIndices()
      ? (this.updatedMessageIndices ?? [])
      : null;

    if (groupsChanged && !patchedGroupMetadata) {
      this.index.rebuildTree(this.groups, this.messages);
    } else if (messagesChanged) {
      if (this.messages.length === prevCount && prevMessages) {
        this.index.updateCachedMessageRefs(
          this.messages,
          prevMessages,
          deltaIndices,
        );
      } else if (this.messages.length > prevCount) {
        this.index.appendNewMessages(this.messages, prevCount);
        // A LOG_DELTA batch may also contain updates to existing entries
        // (e.g. tool status → completed) alongside the appended entries.
        if (prevMessages) {
          this.index.updateCachedMessageRefs(
            this.messages,
            prevMessages,
            deltaIndices,
            prevCount,
          );
        }
      } else {
        this.index.rebuildTree(this.groups, this.messages);
        this.resetRenderWindows();
      }
    }

    // Recompute the interleaved timeline incrementally when possible so the
    // earliest ungrouped message (the user's original instruction) stays at
    // the top for both tool-use and workflow streams.
    if (groupsChanged || messagesChanged) {
      if (
        (groupsChanged && !patchedGroupMetadata) ||
        this.messages.length < prevCount
      ) {
        this.index.rebuildTimeline();
      } else if (messagesChanged && this.messages.length > prevCount) {
        this.index.appendToTimeline(this.messages, prevCount);
        this.index.updateTimelineMessageRefs(this.messages, deltaIndices);
      } else if (messagesChanged) {
        this.index.updateTimelineMessageRefs(this.messages, deltaIndices);
      }
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
   * Play sound when a run group completes. The former stopped status folded
   * `completed`/`cancelled` into one neutral bucket; the native
   * `TaskGroup.status` (#7993 step 3) keeps them apart, so this checks both
   * terminal-but-not-failed phases to preserve the prior "stopped" trigger
   * byte-for-byte — a failed round still does not play the sound.
   */
  private checkForCompletedRuns(): void {
    const nextStatuses = new Map<string, string>();
    for (const group of this.groups) {
      const prev = this.previousStatuses.get(group.id);
      const isRunGroup =
        !this.isToolUse &&
        (group.kind === 'round' ||
          (group.kind === undefined &&
            parseWorkflowOutputRoundDir(group.name) !== null));
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

  private groupMessageScope(groupId: string): string {
    return `group:${groupId}`;
  }

  private renderRevealButton(options: {
    hiddenCount: number;
    step: number;
    scope: string;
    kind: 'timeline' | 'messages';
    label: string;
  }): TemplateResult {
    const revealCount = Math.min(options.hiddenCount, options.step);
    const suffix = revealCount === 1 ? options.label : `${options.label}s`;
    return html`
      <div class="log-reveal-row">
        <wa-button
          appearance="outlined"
          size="small"
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
      (m) => guard([m], () => formatLogEntry(m)),
    )}`;
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
    if (timeline.length <= this.timelineItemWindow) {
      return timeline;
    }
    return timeline.slice(timeline.length - this.timelineItemWindow);
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
        ${
          statusIcon
            ? html`<wa-icon
                library=${TEXRA_ICON_LIBRARY}
                name=${statusIcon}
                aria-hidden="true"
              ></wa-icon>`
            : html`<wa-spinner></wa-spinner>`
        }
      </span>
      <span class="group-title">${group.name}</span>
      <span class="group-time">
        <span class="group-start-time" data-start=${String(group.startTime)}>
          <wa-icon
            library=${TEXRA_ICON_LIBRARY}
            name="clock"
            aria-hidden="true"
          ></wa-icon>
          ${formattedStartTime}
        </span>
        ${
          durationText
            ? html`<span class="group-duration">${durationText}</span>`
            : nothing
        }
      </span>
    `;
  }

  /** Render a group node and its children recursively */
  private renderGroupNode(
    node: GroupTree,
    isRoot = false,
  ): TemplateResult | typeof nothing {
    const { group, children, messages } = node;
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
            ${this.renderMessageEntries(
              messages,
              this.groupMessageScope(group.id),
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
          ${this.renderGroupHeader(group)}
        </div>
        <div id=${contentId} class="log-group-content">
          ${
            expanded
              ? html`${this.renderMessageEntries(
                  messages,
                  this.groupMessageScope(group.id),
                )}${repeat(
                  children,
                  (c) => c.group.id,
                  (c) => this.renderGroupNode(c),
                )}`
              : nothing
          }
        </div>
      </wa-details>
    `;
  }

  private renderTerminalOutput(): TemplateResult {
    const tailText = processTerminalText(this.terminalBuffer.tail);
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
    // Show placeholder only when there are no streams in the current filter
    if (!this.hasStreams) {
      return html`
        <div
          id=${ELEMENT_IDS.LOG_CONTENT}
          class="log-container"
          @scroll=${this.handleScroll}
        >
          ${renderEmptyState({
            icon: 'terminal',
            title: 'No runs yet',
            body: 'Use TeXRA commands to start.',
            headingTag: 'h3',
            className: 'log-placeholder',
            actions: [
              {
                label: 'Run setup',
                icon: 'rocket',
                size: 'small',
                onClick: () => this.handleGettingStartedAction('runSetup'),
              },
              {
                label: 'Sample project',
                icon: 'file-circle-plus',
                size: 'small',
                onClick: () =>
                  this.handleGettingStartedAction('createSampleProject'),
              },
              {
                label: 'Import Overleaf',
                icon: 'cloud-arrow-down',
                size: 'small',
                onClick: () => this.handleGettingStartedAction('cloneOverleaf'),
              },
              {
                label: 'Import arXiv',
                icon: 'download',
                size: 'small',
                onClick: () => this.handleGettingStartedAction('downloadArxiv'),
              },
              {
                label: 'Walkthrough',
                icon: 'book',
                size: 'small',
                onClick: () =>
                  this.handleGettingStartedAction('openWalkthrough'),
              },
            ],
          })}
        </div>
      `;
    }

    // Pre-output placeholder, including terminal-mode (process-agent) streams:
    // with no messages the terminal buffer is empty and would render a blank
    // <pre>, so show the same "Run is starting" / idle text instead.
    if (this.messages.length === 0 && this.groups.length === 0) {
      const parsedPhase = StreamPhaseSchema.safeParse(this.streamStatus);
      const active = parsedPhase.success && isInFlightPhase(parsedPhase.data);
      return html`
        <div
          id=${ELEMENT_IDS.LOG_CONTENT}
          class="log-container"
          @scroll=${this.handleScroll}
        >
          <div class="log-placeholder">
            ${
              active
                ? 'Run is starting. Progress updates will appear here.'
                : 'No log output for this stream yet.'
            }
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
    // groups chronologically so the conversation reads top-to-bottom. Large
    // streams render a recent window first; older timeline entries remain in
    // memory and can be revealed from the top control.
    const visibleTimeline = this.visibleTimelineEntries();
    const hiddenTimelineCount =
      this.index.timeline.length - visibleTimeline.length;

    return html`
      <div
        id=${ELEMENT_IDS.LOG_CONTENT}
        class="log-container"
        @scroll=${this.handleScroll}
      >
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
              ? guard([item.msg], () => formatLogEntry(item.msg))
              : this.renderGroupNode(item.tree, true),
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
