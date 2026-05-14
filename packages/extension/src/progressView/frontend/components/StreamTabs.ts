// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports
import {
  STREAM_STATUS,
  type ConversationProgress,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import {
  renderProgressBadgeContent,
  getProgressBadgeTitle,
} from '../formatters/progressBadgeFormatter';
import {
  designTokens,
  animationStyles,
  commonViewStyles,
} from '@shared/styles';
import {
  AGENT_DECORATORS,
  getAgentCategoryDecorator,
} from '@shared/utils/icons';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import './WorktreeChip';
import { formatRelativeTime } from '@shared/utils/string';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { layoutStyles } from '../styles/logStyles';
import {
  ACTIVE_STREAM_STATUSES,
  ELEMENT_IDS,
  FILTER_BUTTONS,
} from '../constants';
import { ProgressEvents } from '../events';
import { getComposedPathElement, getRadioValue, setsEqual } from '../utils';
import type { StreamState } from '../store';
import type { StreamFilter } from '../store';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/radio/radio.js';
import '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';

type ChildActivity = 'active' | 'finished' | 'unknown';

/**
 * Classify a child stream's lifecycle. Absent entries in `streamStates`
 * (e.g., child just appeared in `childStreamsByParent` before its first
 * status event) are `unknown` — neither active nor finished — so the
 * parent's expand/collapse decision can wait for a real signal.
 */
function classifyChild(
  streamStates: ReadonlyMap<StreamTabId, StreamState>,
  name: StreamTabId,
): ChildActivity {
  const status = streamStates.get(name)?.status;
  if (status === undefined) return 'unknown';
  return ACTIVE_STREAM_STATUSES.has(status) ? 'active' : 'finished';
}

function buildTooltip(
  info: StreamTabInfo,
  lastTimestamp: number | undefined,
  status: string,
): string {
  const mainLine = [
    info.label,
    `Status: ${status}`,
    info.model && `Model: ${info.modelLabel ?? info.model}`,
    info.inputFile && `Input: ${info.inputFile}`,
  ]
    .filter(Boolean)
    .join(' • ');
  const parts = [mainLine];
  if (info.description) {
    parts.push(info.description);
  }
  if (lastTimestamp) {
    const lastSeen = formatRelativeTime(lastTimestamp);
    if (lastSeen) parts.push(`Last activity ${lastSeen}`);
  }
  return parts.join('\n');
}

// =============================================================================
// StreamTab — individual tab component
// =============================================================================

/**
 * Individual stream tab.  Re-renders only when its own `.info` ref or
 * `.active` flag changes.  Since the upstream `streams.map()` preserves
 * object references for unchanged items, most tabs skip rendering entirely
 * on status updates to a single stream.
 */
@customElement('stream-tab')
export class StreamTab extends LitElement {
  static override styles = [
    designTokens,
    animationStyles,
    css`
      :host {
        display: block;
        container-type: inline-size;
      }

      .tab-container {
        display: flex;
        align-items: center;
        position: relative;
        width: 100%;
        gap: var(--wa-space-3xs);
        border-left: var(--border-medium) solid transparent;
      }

      /*
       * Subtle hairline below each row — keeps a refined rhythm for long
       * stream lists without imposing hard grid lines. Drops to invisible
       * on selected/hovered rows so the highlight reads cleanly.
       */
      .tab-container::after {
        content: '';
        position: absolute;
        left: var(--wa-space-3xs);
        right: var(--wa-space-3xs);
        bottom: 0;
        height: 1px;
        background: color-mix(in srgb, var(--color-border) 50%, transparent);
        pointer-events: none;
      }

      .tab-container:hover::after,
      .tab-container.is-active::after {
        opacity: 0;
      }

      .tab-container.status-running {
        border-left-color: var(--color-success);
      }

      .tab-container.status-error {
        border-left-color: var(--color-error);
      }

      .tab-container.status-waiting,
      .tab-container.status-resuming {
        border-left-color: var(--wa-color-text-link);
      }

      .tab-container.status-stopped,
      .tab-container.status-ready {
        border-left-color: var(--color-border);
      }

      .tab-container.status-initializing {
        border-left-color: var(--color-warning);
      }

      /* Pending approval — solid orange left rail. */
      .tab-container.has-pending-approval {
        border-left-color: var(--wa-color-chart-orange, #d18616);
      }

      .tab {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        padding: var(--wa-space-2xs);
        cursor: pointer;
        border: none;
        background: none;
        color: var(--wa-color-text-normal);
        text-align: left;
        font-family: var(--font-family);
        min-width: 0;
        overflow-x: hidden;
      }

      .tab-header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        width: 100%;
      }

      .tab-title {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .tab-description {
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-quiet, var(--wa-color-text-normal));
        opacity: 0.8;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        width: 100%;
        display: none;
      }

      /* Only show description when the tab has enough horizontal space */
      @container (min-width: 200px) {
        .tab-description {
          display: block;
        }
      }

      .tab-meta {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-normal);
        opacity: var(--opacity-subtle);
        width: 100%;
      }

      .tab-meta .remote-agent,
      .tab-meta .agent-category,
      .tab-meta .multi-file {
        margin-left: var(--wa-space-2xs);
      }

      .tab-delete {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: var(--height-control);
        min-width: var(--height-control);
        height: var(--height-control);
        margin: 0 0 0 var(--wa-space-2xs);
        color: var(--wa-color-text-quiet, var(--wa-color-text-normal));
        opacity: 0;
        position: relative;
        z-index: 10;
      }

      /* Reveal the delete affordance only when the row is hovered,
       * focused, or selected — keeps the tabs clean at rest. */
      .tab-container:hover .tab-delete,
      .tab-container.is-active .tab-delete,
      .tab-delete:focus-visible,
      .tab-delete:focus-within {
        opacity: 1;
      }

      .tab-container:hover {
        background-color: color-mix(
          in srgb,
          var(--wa-color-neutral-fill-quiet) 30%,
          transparent
        );
      }

      /*
       * The descendant wildcard rule below forces nested spans
       * (.last-active, .model) and codicon glyphs to inherit the selection
       * color even when intermediate elements define their own.
       */
      .tab-container.is-active {
        background-color: color-mix(
          in srgb,
          var(--wa-color-brand-fill-quiet) 85%,
          transparent
        );
        color: var(--wa-color-list-active-fg, var(--wa-color-text-normal));
      }

      /*
       * Single descendant rule covers .tab, .tab-title, .tab-meta,
       * .tab-description, .tab-delete, .tab-expand, and any nested spans
       * (.last-active, .model) and codicon glyphs.
       */
      .tab-container.is-active * {
        color: var(--wa-color-list-active-fg, var(--wa-color-text-normal));
      }

      /*
       * Re-apply the destructive-action cue on active tabs — the
       * descendant-wildcard above would otherwise hold the close icon on
       * the selection foreground.
       */
      .tab-container.is-active .tab-delete:hover,
      .tab-container.is-active .tab-delete:hover *,
      .tab-container.is-active .tab-delete:focus-within,
      .tab-container.is-active .tab-delete:focus-within * {
        color: var(--wa-color-danger-on-quiet);
      }

      /* Drop the dim-by-default opacity so the flipped foreground renders
       * at full contrast on the selection background. */
      .tab-container.is-active .tab-meta,
      .tab-container.is-active .tab-description {
        opacity: var(--opacity-full);
      }

      .tab-container.is-compact .tab {
        padding: var(--wa-space-2xs) var(--wa-space-3xs);
      }

      .tab-container.is-compact .tab-delete {
        width: 20px;
        min-width: 20px;
        height: 20px;
      }

      .tab-container.is-compact .tab-header {
        gap: var(--wa-space-3xs);
      }

      .compact-subagent-hint {
        font-size: var(--font-size-xs);
        opacity: 0.35;
        flex-shrink: 0;
      }

      .tab-delete::part(base) {
        padding: 0;
        border-radius: var(--border-radius-small);
        background-color: color-mix(
          in srgb,
          var(--wa-color-text-quiet, var(--wa-color-text-normal)) 10%,
          transparent
        );
      }

      .tab-delete:hover,
      .tab-delete:focus-within {
        color: var(--wa-color-danger-on-quiet);
      }

      /* Expand/collapse chevron for parent tabs with children */
      .tab-expand {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        min-width: 20px;
        height: 100%;
        border: none;
        background: none;
        cursor: pointer;
        color: var(--wa-color-text-quiet, var(--wa-color-text-normal));
        opacity: 0.6;
        padding: 0;
      }

      .tab-expand wa-icon {
        font-size: var(--font-size-xs);
      }

      .tab-expand[aria-expanded='true'] wa-icon {
        transform: rotate(90deg);
      }

      .progress-badge-inline {
        font-size: var(--font-size-xs);
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        border-radius: var(--border-radius-small);
        background-color: color-mix(
          in srgb,
          var(--color-text-secondary) 10%,
          transparent
        );
        white-space: nowrap;
        flex-shrink: 0;
      }

      .worktree-chip-row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        width: 100%;
        margin-top: var(--wa-space-3xs);
        min-width: 0;
        overflow: hidden;
      }
    `,
  ];

  @property({ attribute: false }) info!: StreamTabInfo;
  @property({ type: String }) status: string = STREAM_STATUS.READY;
  @property({ attribute: false }) lastTimestamp: number | undefined = undefined;
  @property({ type: Boolean }) active = false;
  @property({ type: Boolean }) compact = false;
  @property({ type: Boolean }) hasPendingApproval = false;
  /** Number of child streams (0 = no toggle shown). */
  @property({ type: Number }) childCount = 0;
  /** Whether the child list is expanded. */
  @property({ type: Boolean, reflect: true }) expanded = false;
  /** Progress data (conversation turns, tool calls). */
  @property({ attribute: false }) progress: ConversationProgress | undefined =
    undefined;

  // Cached derived values — only recomputed when inputs change
  private _cachedInfo: StreamTabInfo | null = null;
  private _agentDecorator = getAgentCategoryDecorator('toolUse');
  private _cachedTooltipKey = '';
  private _tooltip = '';

  override render(): TemplateResult {
    const stream = this.info;
    const status = this.status || STREAM_STATUS.READY;

    // Memoize info-derived values (only change when stream identity changes)
    if (this._cachedInfo !== stream) {
      this._cachedInfo = stream;
      this._agentDecorator = getAgentCategoryDecorator(stream.agentCategory);
      this._cachedTooltipKey = ''; // invalidate tooltip when info changes
    }

    // Memoize tooltip (changes on info, status, or timestamp)
    const tooltipKey = `${status}\0${this.lastTimestamp}`;
    if (this._cachedTooltipKey !== tooltipKey) {
      this._cachedTooltipKey = tooltipKey;
      this._tooltip = buildTooltip(stream, this.lastTimestamp, status);
    }

    const tooltip = this._tooltip;
    const agentDecorator = this._agentDecorator;
    const hasChildren = this.childCount > 0 && !this.compact;
    const childStreamLabel = `${this.childCount} child stream${this.childCount > 1 ? 's' : ''}`;

    return html`
      <div
        class=${classMap({
          'tab-container': true,
          'is-active': this.active,
          'is-compact': this.compact,
          'has-children': hasChildren,
          [`status-${status}`]: Boolean(status),
          'has-pending-approval': this.hasPendingApproval,
        })}
      >
        ${hasChildren
          ? html`<button
              class="tab-expand"
              data-stream=${stream.name}
              data-action="toggle-children"
              title=${this.expanded
                ? 'Collapse child streams'
                : childStreamLabel}
              aria-expanded=${this.expanded ? 'true' : 'false'}
            >
              <wa-icon
                library="texra"
                name="chevron-right"
                aria-hidden="true"
              ></wa-icon>
            </button>`
          : nothing}
        <button
          class="tab"
          data-stream=${stream.name}
          data-action="select"
          title=${tooltip}
        >
          <div class="tab-header">
            <span class="tab-title"
              >${stream.parentStreamId ? '↳ ' : ''}${stream.label ||
              stream.name}</span
            >
            ${this.childCount > 0 && this.compact
              ? html`<wa-icon
                  library="texra"
                  name="chevron-right"
                  class="compact-subagent-hint"
                  role="img"
                  aria-label=${childStreamLabel}
                  title=${childStreamLabel}
                ></wa-icon>`
              : nothing}
          </div>
          ${this.compact
            ? nothing
            : html`
                ${stream.description
                  ? html`<div class="tab-description">
                      ${stream.description}
                    </div>`
                  : nothing}
                ${stream.worktree
                  ? html`<div class="worktree-chip-row">
                      <worktree-chip .info=${stream.worktree}></worktree-chip>
                    </div>`
                  : nothing}
                <div class="tab-meta">
                  <span class="last-active"
                    >${this.lastTimestamp
                      ? formatRelativeTime(this.lastTimestamp)
                      : ''}</span
                  >
                  <span class="model"
                    >${stream.modelLabel ?? stream.model ?? ''}</span
                  >
                  ${this.renderProgressBadge()}
                  <wa-icon
                    library="texra"
                    name=${agentDecorator.icon}
                    class="agent-category"
                    aria-hidden="true"
                    title=${`Category: ${agentDecorator.label}`}
                  ></wa-icon>
                  ${when(
                    stream.isRemote,
                    () => html`
                      <wa-icon
                        library="texra"
                        name=${AGENT_DECORATORS.properties.remote.icon}
                        class="remote-agent"
                        aria-hidden="true"
                        title=${AGENT_DECORATORS.properties.remote.hint}
                      ></wa-icon>
                    `,
                  )}
                </div>
              `}
        </button>
        <wa-button
          class="action-icon-button tab-delete"
          appearance="plain"
          variant="neutral"
          size="small"
          type="button"
          aria-label="Delete stream"
          title="Delete stream"
          data-stream=${stream.name}
          data-action="delete"
        >
          ${waIcon('close')}
        </wa-button>
      </div>
    `;
  }

  private renderProgressBadge(): TemplateResult | typeof nothing {
    if (!this.progress?.conversationTurns) return nothing;
    return html`<span
      class="progress-badge-inline"
      title=${ifDefined(getProgressBadgeTitle(this.progress))}
    >
      ${renderProgressBadgeContent(this.progress)}
    </span>`;
  }
}

// =============================================================================
// StreamTabs — tab list container
// =============================================================================

@customElement('stream-tabs')
export class StreamTabs extends LitElement {
  static override styles = [
    designTokens,
    animationStyles,
    commonViewStyles,
    layoutStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        width: 100%;
        min-height: 0;
        overflow: hidden;
      }

      :host([hidden]) {
        display: none;
      }

      .tabs {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
        font-size: var(--font-size-sm);
        border-left: var(--border-thin) solid var(--color-border);
        height: 100%;
        overflow: visible;
        background-color: var(--background-color);
      }

      :host([compact]) .tabs {
        border-left: none;
      }

      .tabs-content {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
        scrollbar-width: thin;
      }

      .stream-list-footer {
        flex-shrink: 0;
        border-top: var(--border-thin) solid var(--color-border);
        padding: var(--wa-space-2xs) var(--wa-space-xs);
      }

      .stream-list-controls {
        display: flex;
        align-items: flex-start;
        gap: var(--wa-space-2xs);
        min-width: 0;
      }

      .agent-filter-group {
        display: flex;
        justify-content: flex-start;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs);
        flex: 1 1 auto;
        min-width: 0;
      }

      .agent-filter-group vscode-radio,
      .agent-filter-group wa-radio {
        min-width: auto;
        flex: 0 0 auto;
      }

      .stream-list-actions {
        display: flex;
        flex: 0 0 auto;
        justify-content: flex-end;
        margin-left: auto;
      }

      .delete-all-streams {
        color: var(--color-text-secondary);
      }

      .delete-all-streams::part(base) {
        border-radius: var(--border-radius-medium);
      }

      .delete-all-streams:hover {
        color: var(--color-removed);
      }

      /* Recursive child stream nesting */
      .child-streams {
        padding-left: var(--wa-space-xs, 12px);
        border-left: var(--border-thin) solid var(--color-border);
        margin-left: var(--wa-space-2xs);
      }

      .child-streams stream-tab {
        opacity: 1;
        transition: opacity var(--transition-fast);
      }

      .child-streams stream-tab.is-finished {
        opacity: var(--opacity-subtle, 0.5);
      }
    `,
  ];

  @property({ attribute: false }) streams: StreamTabInfo[] = [];
  @property({ type: Boolean, reflect: true }) compact = false;
  @property({ attribute: false }) activeStreamId: string | null = null;
  @property({ attribute: false }) filter: StreamFilter = 'all';
  /**
   * Stream states map — passed directly from ProgressApp's streamStates$.
   * Stable Mutative reference (only changed entries get new refs), so
   * Lit's Object.is() check prevents unnecessary re-renders.
   */
  @property({ attribute: false })
  streamStates: Map<StreamTabId, StreamState> = new Map();
  @property({ attribute: false })
  pendingApprovalStreamIds: Set<string> = new Set();
  @property({ attribute: false })
  childStreamsByParent: Map<string, StreamTabInfo[]> = new Map();

  /** Which parent streams have their child list expanded — derived from
   *  inputs + `userOverride` on every reactive update. Not a source of truth. */
  @state() private expandedParents: Set<string> = new Set();

  /**
   * Per-parent user intent that overrides the auto-expand/collapse rules.
   * Entries live as long as the parent is in `childStreamsByParent`; a new
   * appearance (new run) starts from auto. One map replaces the former
   * `manuallyCollapsed` + `finishedCollapseHandled` sets.
   */
  private userOverride: Map<string, 'expanded' | 'collapsed'> = new Map();
  private branchActivityCache: Map<StreamTabId, ChildActivity> = new Map();

  protected override willUpdate(changed: import('lit').PropertyValues): void {
    if (!changed.has('childStreamsByParent') && !changed.has('streamStates'))
      return;

    this.branchActivityCache.clear();

    for (const parentId of this.userOverride.keys()) {
      if (!this.childStreamsByParent.has(parentId)) {
        this.userOverride.delete(parentId);
      }
    }

    const next = new Set<string>();
    for (const [parentId, children] of this.childStreamsByParent) {
      if (this.computeExpanded(parentId, children)) next.add(parentId);
    }

    if (!setsEqual(next, this.expandedParents)) this.expandedParents = next;
  }

  /**
   * Single source of truth for "is this parent's child list expanded?".
   * Rules (top to bottom):
   *   1. Honor user intent if set.
   *   2. Expand if any child or descendant is actively running.
   *   3. Collapse once every child branch has reached a terminal status.
   *   4. Otherwise (mixed / still-unknown), keep expanded — default on
   *      first appearance before status events arrive.
   */
  private computeExpanded(
    parentId: string,
    children: readonly StreamTabInfo[],
  ): boolean {
    const override = this.userOverride.get(parentId);
    if (override) return override === 'expanded';

    let anyActive = false;
    let anyUnknown = false;
    for (const child of children) {
      const activity = this.getBranchActivity(child.name, new Set([parentId]));
      if (activity === 'active') anyActive = true;
      else if (activity === 'unknown') anyUnknown = true;
    }
    if (anyActive) return true;
    if (anyUnknown) return true;
    return false;
  }

  private getStatus(name: StreamTabId): string {
    return this.streamStates.get(name)?.status ?? STREAM_STATUS.READY;
  }

  private getTimestamp(name: StreamTabId): number | undefined {
    return this.streamStates.get(name)?.lastTimestamp;
  }

  private getProgress(name: StreamTabId): ConversationProgress | undefined {
    const state = this.streamStates.get(name);
    return state?.conversationProgress;
  }

  /**
   * Classify an entire child branch, not just the direct row. Results are
   * memoized for each reactive update so deep child trees are traversed once
   * even though expansion and dimming both ask for branch activity.
   */
  private getBranchActivity(
    streamId: StreamTabId,
    visited: Set<string>,
  ): ChildActivity {
    if (visited.has(streamId))
      return classifyChild(this.streamStates, streamId);

    const cached = this.branchActivityCache.get(streamId);
    if (cached) return cached;

    const ownActivity = classifyChild(this.streamStates, streamId);
    if (ownActivity === 'active') {
      this.branchActivityCache.set(streamId, 'active');
      return 'active';
    }

    const nextVisited = new Set(visited);
    nextVisited.add(streamId);

    let anyUnknown = ownActivity === 'unknown';
    const children = this.childStreamsByParent.get(streamId) ?? [];
    for (const child of children) {
      const childActivity = this.getBranchActivity(child.name, nextVisited);
      if (childActivity === 'active') {
        this.branchActivityCache.set(streamId, 'active');
        return 'active';
      }
      if (childActivity === 'unknown') anyUnknown = true;
    }

    const activity = anyUnknown ? 'unknown' : 'finished';
    this.branchActivityCache.set(streamId, activity);
    return activity;
  }

  private renderStreamNode(
    stream: StreamTabInfo,
    options: { compact: boolean; visited: Set<string> },
  ): TemplateResult {
    const nextVisited = new Set(options.visited);
    nextVisited.add(stream.name);

    const children = (this.childStreamsByParent.get(stream.name) ?? []).filter(
      (child) => !nextVisited.has(child.name),
    );
    const childCount = children.length;
    const expanded =
      !options.compact &&
      childCount > 0 &&
      this.expandedParents.has(stream.name);
    const isFinished =
      stream.parentStreamId != null &&
      this.getBranchActivity(stream.name, options.visited) === 'finished';

    return html`
      <stream-tab
        class=${isFinished ? 'is-finished' : ''}
        .info=${stream}
        .compact=${options.compact}
        .status=${this.getStatus(stream.name)}
        .lastTimestamp=${this.getTimestamp(stream.name)}
        .progress=${this.getProgress(stream.name)}
        ?active=${stream.name === this.activeStreamId}
        .hasPendingApproval=${this.pendingApprovalStreamIds.has(stream.name)}
        .childCount=${childCount}
        ?expanded=${expanded}
      ></stream-tab>
      ${!options.compact && childCount > 0
        ? html`<div class="child-streams" ?hidden=${!expanded}>
            ${repeat(
              children,
              (child) => child.name,
              (child) =>
                this.renderStreamNode(child, {
                  compact: false,
                  visited: nextVisited,
                }),
            )}
          </div>`
        : nothing}
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="tabs">
        <div class="tabs-content">
          <div id=${ELEMENT_IDS.STREAM_TABS} @click=${this.handleTabClick}>
            ${repeat(
              this.streams,
              (stream) => stream.name,
              (stream) =>
                this.renderStreamNode(stream, {
                  compact: this.compact,
                  visited: new Set(),
                }),
            )}
          </div>
          ${when(
            this.streams.length === 0,
            () =>
              html`<div class="log-placeholder">
                No streams yet. Run a TeXRA command to get started.
              </div>`,
          )}
        </div>
        ${this.compact || (this.streams.length === 0 && this.filter === 'all')
          ? nothing
          : html`<div class="stream-list-footer">
              <div class="stream-list-controls">
                <wa-radio-group
                  id=${ELEMENT_IDS.AGENT_FILTER_CONTAINER}
                  class="agent-filter-group"
                  .value=${this.filter}
                  @change=${this.handleFilterChange}
                >
                  ${repeat(
                    FILTER_BUTTONS,
                    (btn) => btn.id,
                    (btn) => html`
                      <wa-radio
                        id=${btn.id}
                        value=${btn.filter}
                        ?checked=${this.filter === btn.filter}
                      >
                        ${btn.label}
                      </wa-radio>
                    `,
                  )}
                </wa-radio-group>

                <div class="stream-list-actions">
                  ${renderIconActionButton({
                    id: ELEMENT_IDS.DELETE_ALL_BTN,
                    icon: 'trash',
                    label: 'Clear all streams',
                    title: 'Clear all streams',
                    className: 'delete-all-streams',
                    onClick: this.handleDeleteAll,
                  })}
                </div>
              </div>
            </div>`}
      </div>
    `;
  }

  private handleTabClick(event: MouseEvent): void {
    const actionElement = getComposedPathElement<HTMLElement>(
      event,
      '[data-stream][data-action]',
    );
    if (!(actionElement instanceof HTMLElement)) return;

    const { stream: streamId, action } = actionElement.dataset;
    if (!streamId) return;

    switch (action) {
      case 'select':
        this.dispatchEvent(ProgressEvents.streamSwitch({ streamId }));
        break;
      case 'delete':
        this.dispatchEvent(ProgressEvents.streamDelete({ streamId }));
        break;
      case 'toggle-children':
        this.toggleChildren(streamId);
        break;
      default:
        break;
    }
  }

  private toggleChildren(parentId: string): void {
    const next = new Set(this.expandedParents);
    const nowExpanded = !next.has(parentId);
    if (nowExpanded) next.add(parentId);
    else next.delete(parentId);
    this.userOverride.set(parentId, nowExpanded ? 'expanded' : 'collapsed');
    this.expandedParents = next;
  }

  private handleFilterChange(event: Event): void {
    const filter = getRadioValue<StreamFilter>(event);
    if (!filter) return;
    this.dispatchEvent(ProgressEvents.filterChange({ filter }));
  }

  private handleDeleteAll(): void {
    this.dispatchEvent(ProgressEvents.deleteAll());
  }
}
