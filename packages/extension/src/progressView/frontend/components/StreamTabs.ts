// Third-party imports
import {
  LitElement,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports
import {
  DEFAULT_STREAM_METADATA_STATUS,
  type StreamSubstate,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import {
  designTokens,
  animationStyles,
  commonViewStyles,
} from '@shared/styles';
import {
  formatStreamStatusLabel,
  streamStatusDisplayKey,
} from '@shared/streams/streamStatusDisplay';
import {
  AGENT_DECORATORS,
  getAgentCategoryDecorator,
} from '@shared/utils/icons';
import { formatResultCount } from '@utils/text/stringUtils';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import './WorktreeChip';
import { formatRelativeTime } from '@shared/utils/string';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { TEXRA_ICON_LIBRARY, waIcon } from '@shared/wa/webAwesomeIcons';
import { renderEmptyState } from '@shared/wa/emptyState';
import { layoutStyles } from '../styles/logStyles';
import { streamTabStyles } from './StreamTab.styles';
import { streamTabsContainerStyles } from './StreamTabsContainer.styles';
import { ELEMENT_IDS, FILTER_BUTTONS } from '../constants';
import { ProgressEvents } from '../events';
import { getComposedPathElement, getRadioValue, setsEqual } from '../utils';
import {
  computeStreamTreeProjection,
  getStreamBranchActivity,
  type StreamBranchActivity,
  type StreamTreeExpansionOverride,
} from '../streamTree';
import type { StreamFilter, StreamState } from '../store';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/radio/radio.js';
import '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

function buildTooltip(
  info: StreamTabInfo,
  lastTimestamp: number | undefined,
  statusLabel: string,
): string {
  const modelDisplay =
    info.kind === 'agent' && info.model
      ? (info.modelLabel ?? info.model)
      : undefined;
  const mainLine = [
    info.label,
    `Status: ${statusLabel}`,
    modelDisplay && `Model: ${modelDisplay}`,
    info.inputFile && `Input: ${info.inputFile}`,
  ]
    .filter(Boolean)
    .join(' · ');
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
  @property({ type: String }) status: string = DEFAULT_STREAM_METADATA_STATUS;
  @property({ attribute: false }) substate: StreamSubstate | undefined;
  @property({ attribute: false }) lastTimestamp: number | undefined = undefined;
  @property({ type: Boolean }) active = false;
  @property({ type: Boolean }) compact = false;
  @property({ type: Boolean }) hasPendingApproval = false;
  /** Number of child streams (0 = no toggle shown). */
  @property({ type: Number }) childCount = 0;
  /** Whether the child list is expanded. */
  @property({ type: Boolean, reflect: true }) expanded = false;

  private _agentDecorator = getAgentCategoryDecorator('toolUse');
  private _tooltip = '';

  protected override willUpdate(changed: PropertyValues): void {
    if (
      !changed.has('info') &&
      !changed.has('status') &&
      !changed.has('substate') &&
      !changed.has('lastTimestamp')
    )
      return;
    if (changed.has('info')) {
      this._agentDecorator = getAgentCategoryDecorator(this.info.agentCategory);
    }
    const status = this.status || DEFAULT_STREAM_METADATA_STATUS;
    const statusLabel =
      formatStreamStatusLabel(status, {
        style: 'progressHeader',
        ...(this.substate ? { substate: this.substate } : {}),
      }) ?? status;
    this._tooltip = buildTooltip(this.info, this.lastTimestamp, statusLabel);
  }

  override render(): TemplateResult {
    const stream = this.info;
    const status = this.status || DEFAULT_STREAM_METADATA_STATUS;
    const statusKey = streamStatusDisplayKey(status, this.substate) ?? status;
    const tooltip = this._tooltip;
    const agentDecorator = this._agentDecorator;
    const hasChildren = this.childCount > 0 && !this.compact;
    const childStreamLabel = formatResultCount(this.childCount, 'child stream');

    return html`
      <div
        class=${classMap({
          'tab-container': true,
          'is-active': this.active,
          'is-compact': this.compact,
          'has-children': hasChildren,
          [`status-${statusKey}`]: Boolean(statusKey),
          'has-pending-approval': this.hasPendingApproval,
        })}
      >
        ${
          hasChildren
            ? html`<wa-button
                class="action-icon-button tab-expand"
                appearance="plain"
                variant="neutral"
                size="small"
                type="button"
                data-stream=${stream.name}
                data-action="toggle-children"
                title=${
                  this.expanded ? 'Collapse child streams' : childStreamLabel
                }
                aria-expanded=${this.expanded ? 'true' : 'false'}
                >${waIcon('chevron-right')}</wa-button
              >`
            : nothing
        }
        <button
          class="tab"
          data-stream=${stream.name}
          data-action="select"
          title=${tooltip}
        >
          <div class="tab-header">
            <span class="tab-title"
              >${
                stream.parentStreamId
                  ? html`<wa-icon
                      library=${TEXRA_ICON_LIBRARY}
                      name="chevron-right"
                      class="nested-stream-icon"
                      aria-hidden="true"
                    ></wa-icon>`
                  : nothing
              }${stream.label || stream.name}</span
            >
            ${
              this.childCount > 0 && this.compact
                ? html`<wa-icon
                    library=${TEXRA_ICON_LIBRARY}
                    name="chevron-right"
                    class="compact-subagent-hint"
                    role="img"
                    aria-label=${childStreamLabel}
                    title=${childStreamLabel}
                  ></wa-icon>`
                : nothing
            }
          </div>
          ${
            this.compact
              ? nothing
              : html`
                  ${
                    stream.description
                      ? html`<div class="tab-description">
                          ${stream.description}
                        </div>`
                      : nothing
                  }
                  ${
                    stream.worktree
                      ? html`<div class="worktree-chip-row">
                          <worktree-chip
                            .info=${stream.worktree}
                          ></worktree-chip>
                        </div>`
                      : nothing
                  }
                  <div class="tab-meta">
                    ${
                      this.lastTimestamp
                        ? html`<wa-relative-time
                            class="last-active"
                            .date=${new Date(this.lastTimestamp)}
                            format="narrow"
                            sync
                          ></wa-relative-time>`
                        : nothing
                    }
                    <span class="model"
                      >${
                        stream.kind === 'agent'
                          ? (stream.modelLabel ?? stream.model ?? '')
                          : ''
                      }</span
                    >
                    <wa-icon
                      library=${TEXRA_ICON_LIBRARY}
                      name=${agentDecorator.icon}
                      class="agent-category"
                      aria-hidden="true"
                      title=${`Category: ${agentDecorator.label}`}
                    ></wa-icon>
                    ${when(
                      stream.isRemote,
                      () => html`
                        <wa-icon
                          library=${TEXRA_ICON_LIBRARY}
                          name=${AGENT_DECORATORS.properties.remote.icon}
                          class="remote-agent"
                          aria-hidden="true"
                          title=${AGENT_DECORATORS.properties.remote.hint}
                        ></wa-icon>
                      `,
                    )}
                  </div>
                `
          }
        </button>
        <wa-button
          id="stream-tab-delete-button"
          class="action-icon-button tab-delete"
          appearance="plain"
          variant="neutral"
          size="small"
          type="button"
          aria-label="Delete stream"
          data-stream=${stream.name}
          data-action="delete"
        >
          ${waIcon('close')}
        </wa-button>
        <wa-tooltip for="stream-tab-delete-button">Delete stream</wa-tooltip>
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
  private userOverride: Map<string, StreamTreeExpansionOverride> = new Map();
  private branchActivityByStream: Map<StreamTabId, StreamBranchActivity> =
    new Map();

  protected override willUpdate(changed: PropertyValues): void {
    if (!changed.has('childStreamsByParent') && !changed.has('streamStates'))
      return;

    const projection = computeStreamTreeProjection({
      streamStates: this.streamStates,
      childStreamsByParent: this.childStreamsByParent,
      userOverrides: this.userOverride,
    });

    this.branchActivityByStream = projection.branchActivityByStream;
    this.userOverride = projection.userOverrides;
    if (!setsEqual(projection.expandedParents, this.expandedParents)) {
      this.expandedParents = projection.expandedParents;
    }
  }

  private getStatus(name: StreamTabId): string {
    return (
      this.streamStates.get(name)?.status ?? DEFAULT_STREAM_METADATA_STATUS
    );
  }

  private getSubstate(name: StreamTabId): StreamSubstate | undefined {
    return this.streamStates.get(name)?.substate;
  }

  private getTimestamp(name: StreamTabId): number | undefined {
    return this.streamStates.get(name)?.lastTimestamp;
  }

  private getBranchActivity(
    streamId: StreamTabId,
    visited: Set<string>,
  ): StreamBranchActivity {
    return getStreamBranchActivity(
      {
        streamStates: this.streamStates,
        childStreamsByParent: this.childStreamsByParent,
      },
      streamId,
      visited,
      this.branchActivityByStream,
    );
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
        .substate=${this.getSubstate(stream.name)}
        .lastTimestamp=${this.getTimestamp(stream.name)}
        ?active=${stream.name === this.activeStreamId}
        .hasPendingApproval=${this.pendingApprovalStreamIds.has(stream.name)}
        .childCount=${childCount}
        ?expanded=${expanded}
      ></stream-tab>
      ${
        !options.compact && childCount > 0
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
          : nothing
      }
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="tabs">
        ${
          this.heading && !this.compact
            ? html`<header class="stream-tabs-header" part="header">
                <span class="stream-tabs-title">${this.heading}</span>
              </header>`
            : nothing
        }
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
          ${when(this.streams.length === 0, () =>
            renderEmptyState({
              icon: 'terminal',
              title: 'No streams yet',
              body: 'Run a TeXRA command to get started.',
              headingTag: 'h3',
              className: 'log-placeholder',
            }),
          )}
        </div>
        ${
          this.compact || (this.streams.length === 0 && this.filter === 'all')
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
                      tooltip: 'Clear all streams',
                      className: 'delete-all-streams',
                      onClick: this.handleDeleteAll,
                    })}
                  </div>
                </div>
              </div>`
        }
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
