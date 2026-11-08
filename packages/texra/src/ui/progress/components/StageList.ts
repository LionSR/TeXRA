/** Declarative stage list — renders stages, headers, and log entries inline. */

// Third-party imports
import { String as Str } from 'effect';
import {
  LitElement,
  css,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { guard } from 'lit/directives/guard.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared schemas
import {
  isInterrupted,
  isWorking,
  type RunId,
  formatCompactDuration,
  pluralize,
} from '@texra-ai/harness/schemas';
import {
  scriptStages,
  transcriptTimeline,
  type ScriptStageView,
  type TimelineEntry,
  type TranscriptRow,
} from '@texra-ai/harness/transcript';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { Surface } from '@texra/shared/session/surface';
import { stageStatus } from '@ui/copy/runStatus';
import { designTokens } from '@ui/styles';

// Side-effect imports - register Web Awesome components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

import { waIcon } from '@ui/wa/webAwesomeIcons';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

// Local imports - progress view styles
import { logStyles } from '../styles/logStyles';

// Local imports - formatters
import { formatLogEntry } from '../formatters';
import { getTimeFormatter } from '../formatters/timestampUtils';
import { dispatchDisclosureToggle } from '../utils';
import type {
  RunView,
  SessionView,
  TranscriptView,
} from '@texra-ai/harness/schemas';

// Local imports - sibling helpers
// Side-effect import: registers <terminal-output>, which the terminal-stream
// render path below instantiates.
import './TerminalOutput';
import './ScriptStage';
import type { TerminalOutput } from './TerminalOutput';

const DEFAULT_TIMELINE_ITEM_WINDOW = 120;
const TIMELINE_ITEM_WINDOW_STEP = 120;
const DEFAULT_STAGE_ROW_WINDOW = 400;
const STAGE_ROW_WINDOW_STEP = 400;

const stageListStyles = css`
  /* Phase labels may come from workflow plans, so let long or untranslated
     values wrap instead of forcing the status and timestamp off-screen. */
  .stage-title {
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .stage-time {
    font-variant-numeric: tabular-nums;
  }
`;

/** One entry of the list: a row no stage holds, or a stage and its rows. */
type Entry = TimelineEntry<TranscriptRow>;
type StageEntry = Extract<Entry, { kind: 'stage' }>;

@customElement('stage-list')
export class StageList extends LitElement {
  static override styles = [designTokens, ...logStyles, stageListStyles];

  /**
   * The stream's transcript slice. The session view appends rows and stages in
   * place and replaces the slice on every change, so the slice, never one
   * of its arrays, is the property Lit compares.
   */
  @property({ attribute: false }) transcript: TranscriptView | null = null;

  private get stages(): TranscriptView['stages'] {
    return this.transcript?.stages ?? [];
  }

  private get rows(): TranscriptView['rows'] {
    return this.transcript?.rows ?? [];
  }

  /** The run, the session and the surface a script stage reads and acts
   *  through; absent, a script stage paints as a plain section. */
  @property({ attribute: false }) run: RunView | null = null;
  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  /** How the host paints tool calls (`HostSnapshot.tools`), set by the
   *  log list. */
  @property({ attribute: false }) tools!: HostSnapshot['tools'];

  /** The run's script stages by id (`scriptStages`). */
  private scripts: ReadonlyMap<string, ScriptStageView> = new Map();

  /** The stream these rows belong to; every stage toggle names it. */
  @property({ attribute: false }) runId: RunId | null = null;

  /** `RunSurface.disclosures` for this stream: true is expanded, false collapsed,
   *  a missing key expanded. Toggles go out as surface actions. */
  @property({ attribute: false }) expanded:
    | ReadonlyMap<string, boolean>
    | undefined = undefined;

  /**
   * Render log output in terminal style (monospace, no bullets/timestamps).
   * Reflected to the host attribute so scoped CSS can target it.
   */
  @property({ type: Boolean, reflect: true }) terminal = false;

  /** The transcript laid out for render (`transcriptTimeline`), rebuilt
   *  when the transcript changes. */
  private timeline: Entry[] = [];

  /** Number of recent top-level timeline entries currently rendered. */
  @state() private timelineItemWindow = DEFAULT_TIMELINE_ITEM_WINDOW;

  /** Number of recent rows rendered for each stage. Reassigned
   *  (never mutated in place) so the reactive update cycle picks up changes. */
  @state() private stageRowWindows = new Map<string, number>();

  /** Reference to the scroll container */
  @query(`#${ELEMENT_IDS.LOG_CONTENT}`)
  private scrollContainer?: HTMLElement;

  /** xterm renderer for terminal-mode runs; owns its own viewport. */
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
    this.isSticky = this.isNearBottom(StageList.STICKY_THRESHOLD);
  };

  /** Public method to scroll to bottom - called by parent LogList */
  scrollToBottom(): void {
    if (this.terminal) {
      // xterm owns the viewport for terminal runs. LogList calls this on a
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
    // Terminal runs: the terminal keeps its own viewport pinned unless the
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

  override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('run') || changedProperties.has('view')) {
      this.scripts =
        this.run && this.view
          ? new Map(
              scriptStages(this.run, this.view).map((stage) => [
                stage.id,
                stage,
              ]),
            )
          : new Map();
    }
    const transcriptChanged = changedProperties.has('transcript');
    if (this.terminal || !transcriptChanged) return;
    this.timeline = this.transcript ? transcriptTimeline(this.transcript) : [];
    // The windows count from the tail; a transcript that shrank (a
    // replaced history) or a fresh mount no longer lines up with them.
    const previous = changedProperties.get('transcript');
    if (
      changedProperties.get('terminal') === true ||
      (previous != null && this.rows.length < previous.rows.length)
    ) {
      this.resetRenderWindows();
    }
  }

  private resetRenderWindows(): void {
    this.timelineItemWindow = DEFAULT_TIMELINE_ITEM_WINDOW;
    this.stageRowWindows = new Map();
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
          @click=${(event: Event) =>
            this.revealOlder(event, options.kind, options.scope)}
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
      this.stageRowWindows.get(scope) ?? DEFAULT_STAGE_ROW_WINDOW;
    const hiddenCount = Math.max(0, rows.length - windowSize);
    const visibleRows = hiddenCount > 0 ? rows.slice(hiddenCount) : rows;

    return html`${
      hiddenCount > 0
        ? this.renderRevealButton({
            hiddenCount,
            step: STAGE_ROW_WINDOW_STEP,
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
   * the same object and its run's interrupted fact holds. A row is replaced
   * (never patched) whenever its source entry changes, so reference identity
   * is the freshness test for the row itself. The host's tool display is no
   * part of the guard: it comes from the process's plugin list, is in the
   * first host snapshot before any row paints, and every host frame decodes
   * a fresh copy of the same record.
   */
  private renderLogEntry(row: TranscriptRow) {
    const interrupted = this.run !== null && isInterrupted(this.run);
    return guard([row, interrupted], () =>
      formatLogEntry(row, interrupted, this.tools),
    );
  }

  private revealOlder(
    event: Event,
    kind: 'timeline' | 'rows',
    scope: string,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    if (kind === 'timeline') {
      this.timelineItemWindow += TIMELINE_ITEM_WINDOW_STEP;
    } else {
      const current =
        this.stageRowWindows.get(scope) ?? DEFAULT_STAGE_ROW_WINDOW;
      this.stageRowWindows = new Map(this.stageRowWindows).set(
        scope,
        current + STAGE_ROW_WINDOW_STEP,
      );
    }
  }

  private visibleTimelineEntries(): Entry[] {
    const timeline = this.timeline;
    return timeline.length <= this.timelineItemWindow
      ? timeline
      : timeline.slice(-this.timelineItemWindow);
  }

  /** Whether a stage is expanded. */
  private isExpanded(stageId: string): boolean {
    return this.expanded?.get(stageId) !== false;
  }

  private isNearBottom(threshold: number): boolean {
    if (!this.scrollContainer) return false;
    const remaining =
      this.scrollContainer.scrollHeight -
      this.scrollContainer.scrollTop -
      this.scrollContainer.clientHeight;
    return remaining <= threshold;
  }

  /** A section's header: its status, title, start and duration. */
  private renderStageHeader(node: StageEntry): TemplateResult {
    const { stage } = node;
    const formattedStartTime = getTimeFormatter().format(
      new Date(stage.startTime),
    );
    const durationText = stage.endTime
      ? formatCompactDuration(stage.endTime - stage.startTime)
      : '';

    const status = stageStatus(stage, this.run);
    return html`
      <span class="stage-status-icon">
        ${waIcon(status.glyph, { label: status.word })}
      </span>
      <bdi class="stage-title">${stage.name}</bdi>
      <span class="stage-time">
        <span class="stage-start-time">
          ${waIcon('clock')}
          <span class="visually-hidden">Started at </span>
          <time datetime=${new Date(stage.startTime).toISOString()}
            >${formattedStartTime}</time
          >
        </span>
        ${
          durationText
            ? html`<span class="stage-duration"
                ><span class="visually-hidden">Duration </span
                >${durationText}</span
              >`
            : nothing
        }
      </span>
    `;
  }

  /** Rows of a stage, in transcript order. A script stage leads with its
   *  calls as the script-stage model reads them; the calls' own cards, with
   *  their output, open below it from the card's Log. */
  private renderStageBody(node: StageEntry): TemplateResult {
    const script = this.scripts.get(node.stage.id);
    const rows = this.renderRowEntries(node.rows, `stage:${node.stage.id}`);
    const callsKey = `calls:${node.stage.id}`;
    const callsOpen = this.expanded?.get(callsKey) === true;
    return html`${
      script && this.view && this.surface
        ? html`<script-stage
              .stage=${script}
              .view=${this.view}
              .surface=${this.surface}
              .runId=${this.runId}
              ?logOpen=${callsOpen}
            ></script-stage>
            ${callsOpen ? rows : nothing}`
        : rows
    }`;
  }

  /** Render a stage: a script stage as a plain container, its script-stage
   *  view heading it; any other as a collapsible section with a header. */
  private renderStage(node: StageEntry): TemplateResult {
    const { stage } = node;

    if (this.scripts.has(stage.id)) {
      return html`
        <div class="stage stage-script">
          <div class="stage-content">${this.renderStageBody(node)}</div>
        </div>
      `;
    }

    // Collapsed sections contribute zero DOM nodes for their content.
    const expanded = this.isExpanded(stage.id);
    // wa-show and wa-hide both: `dispatchDisclosureToggle` owns the bubble guard
    // and reads the direction from the event type.
    const onToggle = (event: Event) =>
      dispatchDisclosureToggle(this, event, this.runId, stage.id);

    return html`
      <wa-details
        class="stage"
        ?open=${expanded}
        @wa-show=${onToggle}
        @wa-hide=${onToggle}
      >
        <div slot="summary" class="stage-header">
          ${this.renderStageHeader(node)}
        </div>
        <div class="stage-content">
          ${expanded ? this.renderStageBody(node) : nothing}
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
    // Pre-output placeholder, including terminal-mode (process-agent) runs:
    // with no output the terminal buffer is empty and would render a blank
    // pane, so show the same "Task is starting" / idle text instead.
    if (this.rows.length === 0 && this.stages.length === 0) {
      const active = this.run !== null && isWorking(this.run);
      const noun = this.run?.parentId ? 'agent' : 'task';
      return html`
        <div class="log-placeholder">
          ${
            active
              ? `${Str.capitalize(noun)} is starting. Progress updates will appear here.`
              : `No log output for this ${noun} yet.`
          }
        </div>
      `;
    }

    if (this.terminal) {
      return this.renderTerminalOutput();
    }

    // Rows no stage holds (user input, follow-ups, errors) and the stages,
    // in transcript order. Large runs render a recent window first; older
    // entries remain in memory and can be revealed from the top control.
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
        (item) => (item.kind === 'row' ? item.row.id : item.stage.id),
        (item) =>
          item.kind === 'row'
            ? this.renderLogEntry(item.row)
            : this.renderStage(item),
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'stage-list': StageList;
  }
}
