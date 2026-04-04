// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
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
import type { StreamState } from '../store';
import {
  designTokens,
  animationStyles,
  commonViewStyles,
} from '@shared/styles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';
import {
  AGENT_DECORATORS,
  getAgentCategoryDecorator,
} from '@shared/utils/icons';
import { formatRelativeTime } from '@shared/utils/string';
import { layoutStyles } from '../styles/logStyles';
import { ELEMENT_IDS, FILTER_BUTTONS, SORT_BUTTONS } from '../constants';
import { ProgressEvents } from '../events';
import { getComposedPathElement, getRadioValue } from '../utils';
import type { StreamFilter, StreamSort } from '../store';

/** Stream statuses considered active (non-terminal) for child stream display. */
const ACTIVE_CHILD_STATUSES: ReadonlySet<string> = new Set([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.WAITING,
  STREAM_STATUS.INITIALIZING,
  STREAM_STATUS.RESUMING,
]);

function buildTooltip(
  info: StreamTabInfo,
  lastTimestamp: number | undefined,
  status: string,
): string {
  const mainLine = [
    info.label,
    `Status: ${status}`,
    info.model && `Model: ${info.model}`,
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
    codiconIconClasses,
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
        gap: var(--spacing-tiny);
        border-left: var(--border-thick) solid transparent;
        transition:
          border-left-color var(--transition-normal),
          background-color var(--transition-fast);
      }

      .tab-container.status-running {
        border-left-color: var(--color-success);
      }

      .tab-container.status-error {
        border-left-color: var(--color-error);
      }

      .tab-container.status-waiting,
      .tab-container.status-resuming {
        border-left-color: var(--vscode-textLink-foreground);
      }

      .tab-container.status-stopped,
      .tab-container.status-ready {
        border-left-color: var(--color-border);
      }

      .tab-container.status-initializing {
        border-left-color: var(--color-warning);
      }

      /* Pending approval — pulsing orange, visually distinct from all status colors */
      @keyframes pulse-border {
        0%,
        100% {
          border-left-color: var(--vscode-charts-orange, #d18616);
        }
        50% {
          border-left-color: transparent;
        }
      }

      .tab-container.has-pending-approval {
        animation: pulse-border 2s ease-in-out infinite;
      }

      .tab {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        padding: var(--spacing-small);
        cursor: pointer;
        border: none;
        background: none;
        color: var(--vscode-foreground);
        text-align: left;
        font-family: var(--font-family);
        min-width: 0;
        overflow-x: hidden;
      }

      .tab-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
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
        color: var(--vscode-descriptionForeground, var(--vscode-foreground));
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
        gap: var(--spacing-small);
        font-size: var(--font-size-sm);
        color: var(--vscode-foreground);
        opacity: var(--opacity-subtle);
        width: 100%;
      }

      .tab-meta .remote-agent,
      .tab-meta .agent-category,
      .tab-meta .multi-file {
        margin-left: var(--spacing-small);
      }

      .tab-delete {
        flex-shrink: 0;
        display: flex !important;
        visibility: visible !important;
        opacity: var(--opacity-full) !important;
        align-items: center;
        justify-content: center;
        width: var(--height-control);
        min-width: var(--height-control);
        height: var(--height-control);
        margin: 0 var(--spacing-small) 0 0;
        color: var(--vscode-icon-foreground, var(--vscode-foreground));
        transition:
          color var(--transition-fast),
          background-color var(--transition-fast);
      }

      .tab-container:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .tab-container.is-active {
        background-color: var(--vscode-list-activeSelectionBackground);
      }

      .tab-container.is-active .tab {
        color: var(--vscode-list-activeSelectionForeground);
      }

      .tab-container.is-compact .tab {
        padding: var(--spacing-small) var(--spacing-tiny);
      }

      .tab-container.is-compact .tab-header {
        gap: var(--spacing-tiny);
      }

      .tab-delete::part(control) {
        padding: 0;
        border-radius: var(--border-radius-small);
        background-color: color-mix(
          in srgb,
          var(--vscode-icon-foreground, var(--vscode-foreground)) 10%,
          transparent
        );
      }

      .tab-delete:hover::part(control),
      .tab-delete:focus-within::part(control) {
        background-color: var(--vscode-toolbar-hoverBackground);
      }

      .tab-delete:hover,
      .tab-delete:focus-within {
        color: var(--vscode-errorForeground);
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
        color: var(--vscode-icon-foreground, var(--vscode-foreground));
        opacity: 0.6;
        padding: 0;
      }

      .tab-expand:hover {
        opacity: 1;
        background-color: var(--vscode-toolbar-hoverBackground);
      }

      .tab-expand .codicon {
        font-size: var(--font-size-xs);
        transition: transform var(--transition-fast);
      }

      .tab-expand[aria-expanded='true'] .codicon {
        transform: rotate(90deg);
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

  // Cached derived values — only recomputed when inputs change
  private _cachedInfo: StreamTabInfo | null = null;
  private _compactLabel = '';
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
      const raw =
        `${stream.parentStreamId ? '↳' : ''}${stream.label || stream.name}`.trim();
      this._compactLabel = raw.length > 8 ? raw.slice(0, 7) + '…' : raw;
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
    const compactLabel = this._compactLabel;
    const hasChildren = this.childCount > 0 && !this.compact;

    return html`
      <div
        class=${classMap({
          'tab-container': true,
          'stream-tab': true,
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
                : `${this.childCount} child stream${this.childCount > 1 ? 's' : ''}`}
              aria-expanded=${this.expanded ? 'true' : 'false'}
            >
              <i class="codicon codicon-chevron-right"></i>
            </button>`
          : nothing}
        <button
          class="tab"
          data-stream=${stream.name}
          data-action="select"
          title=${tooltip}
        >
          <div class="tab-header">
            <span class="tab-title">
              ${this.compact
                ? compactLabel
                : `${stream.parentStreamId ? '↳ ' : ''}${stream.label || stream.name}`}
            </span>
          </div>
          ${this.compact
            ? nothing
            : html`
                ${stream.description
                  ? html`<div class="tab-description">
                      ${stream.description}
                    </div>`
                  : nothing}
                <div class="tab-meta">
                  <span class="last-active"
                    >${this.lastTimestamp
                      ? formatRelativeTime(this.lastTimestamp)
                      : ''}</span
                  >
                  <span class="model">${stream.model ?? ''}</span>
                  <i
                    class=${`codicon codicon-${agentDecorator.icon} agent-category`}
                    title=${`Category: ${agentDecorator.label}`}
                  ></i>
                  ${when(
                    stream.isRemote,
                    () => html`
                      <i
                        class=${`codicon codicon-${AGENT_DECORATORS.properties.remote.icon} remote-agent`}
                        title=${AGENT_DECORATORS.properties.remote.hint}
                      ></i>
                    `,
                  )}
                  ${when(
                    stream.hasMultipleOutputs,
                    () => html`
                      <i
                        class=${`codicon codicon-${AGENT_DECORATORS.properties.multipleOutputs.icon} multi-file`}
                        title=${AGENT_DECORATORS.properties.multipleOutputs
                          .hint}
                      ></i>
                    `,
                  )}
                </div>
              `}
        </button>
        ${this.compact
          ? nothing
          : html`
              <vscode-toolbar-button
                class="tab-delete"
                icon="close"
                title="Delete stream"
                aria-label="Delete stream"
                data-stream=${stream.name}
                data-action="delete"
              ></vscode-toolbar-button>
            `}
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
      }

      .clear-all-container {
        flex-shrink: 0;
        border-top: var(--border-thin) solid var(--color-border);
        padding: var(--spacing-small);
      }

      .agent-filter-group {
        display: flex;
        justify-content: flex-start;
        flex-wrap: wrap;
        gap: var(--spacing-small);
        margin-bottom: var(--spacing-small);
      }

      .agent-filter-group vscode-radio {
        min-width: auto;
        flex: 0 0 auto;
      }

      .sort-btn.active::part(control) {
        background-color: var(--vscode-toolbar-hoverBackground);
      }

      /* Child stream nesting */
      .child-streams {
        padding-left: var(--spacing-medium, 12px);
        border-left: var(--border-thin) solid var(--color-border);
        margin-left: var(--spacing-small);
        max-height: 12rem;
        overflow-y: auto;
        scrollbar-gutter: stable;
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
  @property({ attribute: false }) sort: StreamSort = 'time';
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

  /** Which parent streams have their child list expanded. */
  @state() private expandedParents: Set<string> = new Set();

  /**
   * Parents the user has manually collapsed. Auto-expand won't override
   * these — only cleared when all children finish (parent leaves the map).
   */
  private manuallyCollapsed: Set<string> = new Set();

  /** Auto-expand parents when children appear, auto-collapse when gone. */
  protected override willUpdate(
    changed: import('lit').PropertyValues,
  ): void {
    if (!changed.has('childStreamsByParent')) return;

    let dirty = false;
    const next = new Set(this.expandedParents);

    // Auto-expand NEW parents (not yet seen and not manually collapsed)
    for (const parentId of this.childStreamsByParent.keys()) {
      if (!next.has(parentId) && !this.manuallyCollapsed.has(parentId)) {
        next.add(parentId);
        dirty = true;
      }
    }
    // Auto-collapse parents that lost all children + clear manual state
    for (const parentId of next) {
      if (!this.childStreamsByParent.has(parentId)) {
        next.delete(parentId);
        this.manuallyCollapsed.delete(parentId);
        dirty = true;
      }
    }
    // Also clean manual set for parents no longer in the map
    for (const parentId of this.manuallyCollapsed) {
      if (!this.childStreamsByParent.has(parentId)) {
        this.manuallyCollapsed.delete(parentId);
      }
    }
    if (dirty) this.expandedParents = next;
  }

  private getStatus(name: StreamTabId): string {
    return this.streamStates.get(name)?.status ?? STREAM_STATUS.READY;
  }

  private getTimestamp(name: StreamTabId): number | undefined {
    return this.streamStates.get(name)?.lastTimestamp;
  }

  override render(): TemplateResult {
    return html`
      <div class="tabs">
        <div class="tabs-content">
          <div id=${ELEMENT_IDS.STREAM_TABS} @click=${this.handleTabClick}>
            ${repeat(
              this.streams,
              (stream) => stream.name,
              (stream) => {
                const children =
                  this.childStreamsByParent.get(stream.name);
                const childCount = !this.compact ? (children?.length ?? 0) : 0;
                const expanded =
                  childCount > 0 && this.expandedParents.has(stream.name);

                // prettier-ignore
                return html`<stream-tab .info=${stream} .compact=${this.compact} .status=${this.getStatus(stream.name)} .lastTimestamp=${this.getTimestamp(stream.name)} ?active=${stream.name === this.activeStreamId} .hasPendingApproval=${this.pendingApprovalStreamIds.has(stream.name)} .childCount=${childCount} ?expanded=${expanded}></stream-tab>${children && childCount > 0 ? html`<div class="child-streams" ?hidden=${!expanded}>${repeat(children, (child) => child.name, (child) => {
                  const childStatus = this.getStatus(child.name);
                  const isFinished = !ACTIVE_CHILD_STATUSES.has(childStatus);
                  // prettier-ignore
                  return html`<stream-tab class=${isFinished ? 'is-finished' : ''} .info=${child} .compact=${false} .status=${childStatus} .lastTimestamp=${this.getTimestamp(child.name)} ?active=${child.name === this.activeStreamId} .hasPendingApproval=${this.pendingApprovalStreamIds.has(child.name)}></stream-tab>`;
                })}</div>` : nothing}`;
              },
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
        ${this.compact
          ? nothing
          : html`<div class="clear-all-container">
              <vscode-radio-group
                id=${ELEMENT_IDS.AGENT_FILTER_CONTAINER}
                class="agent-filter-group"
                .value=${this.filter}
                @change=${this.handleFilterChange}
              >
                ${repeat(
                  FILTER_BUTTONS,
                  (btn) => btn.id,
                  (btn) => html`
                    <vscode-radio
                      id=${btn.id}
                      value=${btn.filter}
                      ?checked=${this.filter === btn.filter}
                    >
                      ${btn.label}
                    </vscode-radio>
                  `,
                )}
              </vscode-radio-group>

              <vscode-toolbar-container
                id="sortButtons"
                @click=${this.handleSortClick}
              >
                ${repeat(
                  SORT_BUTTONS,
                  (btn) => btn.id,
                  (btn) => html`
                    <vscode-toolbar-button
                      id=${btn.id}
                      icon=${btn.icon}
                      label=${btn.title}
                      title=${btn.title}
                      data-sort=${btn.sort}
                      aria-pressed=${this.sort === btn.sort ? 'true' : 'false'}
                      class=${classMap({
                        'sort-btn': true,
                        active: this.sort === btn.sort,
                      })}
                    ></vscode-toolbar-button>
                  `,
                )}
                <vscode-toolbar-button
                  id=${ELEMENT_IDS.DELETE_ALL_BTN}
                  icon="close-all"
                  label="Clear all"
                  title="Clear all streams"
                  @click=${this.handleDeleteAll}
                ></vscode-toolbar-button>
              </vscode-toolbar-container>
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
    if (next.has(parentId)) {
      next.delete(parentId);
      this.manuallyCollapsed.add(parentId);
    } else {
      next.add(parentId);
      this.manuallyCollapsed.delete(parentId);
    }
    this.expandedParents = next;
  }

  private handleFilterChange(event: Event): void {
    const filter = getRadioValue<StreamFilter>(event);
    if (!filter) return;
    this.dispatchEvent(ProgressEvents.filterChange({ filter }));
  }

  private handleSortClick(event: MouseEvent): void {
    const button = getComposedPathElement<HTMLElement>(event, '[data-sort]');
    if (!(button instanceof HTMLElement) || !button.dataset.sort) return;

    this.dispatchEvent(
      ProgressEvents.sortChange({ sort: button.dataset.sort as StreamSort }),
    );
  }

  private handleDeleteAll(): void {
    this.dispatchEvent(ProgressEvents.deleteAll());
  }
}
