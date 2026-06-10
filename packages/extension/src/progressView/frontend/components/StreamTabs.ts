// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports
import {
  STREAM_STATUS,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
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
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import './WorktreeChip';
import { formatRelativeTime } from '@shared/utils/string';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { layoutStyles } from '../styles/logStyles';
import { streamTabStyles, streamTabsContainerStyles } from './streamTabsStyles';
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
  static override styles = [designTokens, animationStyles, streamTabStyles];

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
                  ${this.lastTimestamp
                    ? html`<wa-relative-time
                        class="last-active"
                        .date=${new Date(this.lastTimestamp)}
                        format="narrow"
                        sync
                      ></wa-relative-time>`
                    : nothing}
                  <span class="model"
                    >${stream.modelLabel ?? stream.model ?? ''}</span
                  >
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
    streamTabsContainerStyles,
  ];

  @property({ attribute: false }) streams: StreamTabInfo[] = [];
  @property({ type: Boolean, reflect: true }) compact = false;
  /** Optional rail-header title. Empty (default) renders no header band. */
  @property({ type: String }) heading = '';
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

    return children.some(
      (child) =>
        this.getBranchActivity(child.name, new Set([parentId])) !== 'finished',
    );
  }

  private getStatus(name: StreamTabId): string {
    return this.streamStates.get(name)?.status ?? STREAM_STATUS.READY;
  }

  private getTimestamp(name: StreamTabId): number | undefined {
    return this.streamStates.get(name)?.lastTimestamp;
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
        class=${classMap({ 'is-finished': isFinished })}
        .info=${stream}
        .compact=${options.compact}
        .status=${this.getStatus(stream.name)}
        .lastTimestamp=${this.getTimestamp(stream.name)}
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
        ${this.heading && !this.compact
          ? html`<header class="stream-tabs-header" part="header">
              <span class="stream-tabs-title">${this.heading}</span>
            </header>`
          : nothing}
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
