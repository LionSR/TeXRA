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
  STREAM_PHASE,
  STREAM_SUBSTATE,
  runIdentityDisplayName,
  type StreamSubstate,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import { isTerminalOutcomePhase } from '@shared/streams/streamStatus';
import {
  formatStreamStatusLabel,
  streamStatusDisplayKey,
  type StreamStatusDisplayKey,
} from '@shared/streams/streamStatusDisplay';
import {
  AGENT_DECORATORS,
  getAgentCategoryDecorator,
} from '@shared/utils/icons';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import './WorktreeChip';
import { formatRelativeTime } from '@shared/utils/string';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { type TeXRAIconName } from '@shared/wa/iconNames';
import { renderEmptyState } from '@shared/wa/emptyState';
import { BACKGROUND_TASK } from '@shared/copy/nestedRuns';
import { formatResultCount } from '@utils/text/stringUtils';
import { layoutStyles } from '../styles/logStyles';
import { streamTabStyles } from './StreamTab.styles';
import { streamTabsContainerStyles } from './StreamTabsContainer.styles';
import { ELEMENT_IDS } from '../constants';
import { ProgressEvents } from '../events';
import {
  getComposedPathElement,
  setsEqual,
  streamDisplayLabel,
} from '../utils';
import {
  computeStreamTreeProjection,
  type StreamTreeExpansionOverride,
} from '../streamTree';
import type { StreamState } from '../store';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

/** Shape cue paired with the visible status label on every canonical state. */
const STATUS_ICONS: Record<StreamStatusDisplayKey, TeXRAIconName> = {
  [STREAM_SUBSTATE.STARTING]: 'spinner',
  [STREAM_SUBSTATE.RESUMING]: 'spinner',
  [STREAM_PHASE.RUNNING]: 'play',
  [STREAM_PHASE.WAITING]: 'clock',
  [STREAM_PHASE.COMPLETED]: 'circle-check',
  [STREAM_PHASE.FAILED]: 'circle-exclamation',
  [STREAM_PHASE.CANCELLED]: 'circle-stop',
  ready: 'circle',
};

function buildTooltip(
  info: StreamTabInfo,
  lastTimestamp: number | undefined,
  statusLabel: string,
): string {
  const modelDisplay =
    info.identity?.kind === 'agent' && info.model
      ? (info.modelLabel ?? info.model)
      : undefined;
  const worktreeDisplay = info.worktree
    ? `Worktree: ${info.worktree.branch}${info.worktree.pr ? ` (#${info.worktree.pr.number})` : ''}`
    : undefined;
  // Prefer the declared RunIdentity over the derived tab label.
  const identityDisplay = info.identity
    ? runIdentityDisplayName(info.identity)
    : undefined;
  const mainLine = [
    identityDisplay || streamDisplayLabel(info),
    `Status: ${statusLabel}`,
    modelDisplay && `Model: ${modelDisplay}`,
    worktreeDisplay,
  ]
    .filter(Boolean)
    .join(' · ');
  const parts = [mainLine];
  if (info.description) {
    parts.push(info.description);
  }
  // The opaque id: off the row's visible text, but kept in the row's
  // accessible name — it is what tells two parallel runs of the same agent
  // apart. This summary is deliberately aria-only (#9168): a visual tooltip
  // spanning the whole row would fight the specific per-icon hints
  // (`stream-tab-kind`, `stream-tab-remote`, the worktree chip) it encloses.
  // The header and parent-breadcrumb do carry it on hover.
  parts.push(info.name);
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
class StreamTab extends LitElement {
  static override styles = [designTokens, streamTabStyles];

  @property({ attribute: false }) info!: StreamTabInfo;
  @property({ type: String }) status: string = DEFAULT_STREAM_METADATA_STATUS;
  @property({ attribute: false }) substate: StreamSubstate | undefined;
  @property({ attribute: false }) lastTimestamp: number | undefined = undefined;
  @property({ type: Boolean }) active = false;
  @property({ type: Boolean }) compact = false;
  @property({ type: Boolean }) hasPendingApproval = false;
  /** Number of nested background tasks (0 = no toggle shown). */
  @property({ type: Number }) childCount = 0;
  /** Whether the child list is expanded. */
  @property({ type: Boolean, reflect: true }) expanded = false;

  private _streamDecorator: {
    readonly icon: TeXRAIconName;
    readonly label: string;
  } = getAgentCategoryDecorator('toolUse');

  protected override willUpdate(changed: PropertyValues): void {
    if (!changed.has('info')) return;
    const identityKind = this.info.identity?.kind;
    this._streamDecorator =
      identityKind === 'multiAgentWorkflow' || identityKind === 'process'
        ? AGENT_DECORATORS.streamKinds[identityKind]
        : getAgentCategoryDecorator(this.info.agentCategory);
  }

  override render(): TemplateResult {
    const stream = this.info;
    const status = this.status || DEFAULT_STREAM_METADATA_STATUS;
    const displayKey = streamStatusDisplayKey(status, this.substate);
    const statusKey = displayKey ?? status;
    const lifecycleStatusLabel =
      formatStreamStatusLabel(status, {
        style: 'progressHeader',
        ...(this.substate ? { substate: this.substate } : {}),
      }) ?? status;
    // Pending approval outranks the lifecycle phase: a run held at the
    // approval gate is still "running", and the gate is what you act on.
    const statusGlyph = this.hasPendingApproval
      ? 'triangle-exclamation'
      : displayKey && STATUS_ICONS[displayKey];
    const visibleStatusLabel = this.hasPendingApproval
      ? 'Approval'
      : lifecycleStatusLabel;
    const accessibleStatusLabel = this.hasPendingApproval
      ? 'Approval required'
      : lifecycleStatusLabel;
    // Also names the delete button: one "Delete" repeated down the rail tells
    // a screen-reader user nothing about which session it destroys.
    const streamTitle = stream.description || streamDisplayLabel(stream);
    const streamDecorator = this._streamDecorator;
    const hasChildren = this.childCount > 0 && !this.compact;
    const showCompactChildHint = this.childCount > 0 && this.compact;
    // "Background task" covers every nested run — delegated agents, agent CLIs
    // and background commands — matching the Background tasks panel; "child
    // stream" is the internal stream-tree name and stays out of the UI.
    const childCountLabel = formatResultCount(
      this.childCount,
      BACKGROUND_TASK.countNoun,
    );
    const childToggleLabel = this.expanded
      ? BACKGROUND_TASK.collapseAction
      : childCountLabel;
    const selectLabel = buildTooltip(
      stream,
      this.lastTimestamp,
      accessibleStatusLabel,
    );
    const compactSelectLabel = showCompactChildHint
      ? `${selectLabel}\n${childCountLabel}`
      : selectLabel;
    // RunIdentity is the declared authority for what owns the stream, shown
    // in the meta line so a glance at the row says who ran it. Only when the
    // title is the AI one-liner (`stream.description`) — otherwise the title
    // already *is* this same identity name (see `streamTitle` above) and
    // repeating it in the meta line underneath would just echo the title.
    const metaAgentName =
      stream.identity?.kind === 'agent' && stream.description
        ? runIdentityDisplayName(stream.identity)
        : undefined;

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
                  id="stream-tab-expand-button"
                  class="action-icon-button tab-expand"
                  appearance="plain"
                  variant="neutral"
                  size="s"
                  type="button"
                  data-stream=${stream.name}
                  data-action="toggle-children"
                  aria-label=${childToggleLabel}
                  aria-expanded=${this.expanded ? 'true' : 'false'}
                  >${waIcon('chevron-right')}</wa-button
                ><wa-tooltip for="stream-tab-expand-button"
                  >${childToggleLabel}</wa-tooltip
                >`
            : nothing
        }
        <button
          id="stream-tab-select-button"
          class="tab"
          data-stream=${stream.name}
          data-action="select"
          aria-label=${compactSelectLabel}
        >
          <div class="tab-header">
            <span id="stream-tab-title" class="tab-title"
              >${
                stream.parentStreamId
                  ? waIcon('chevron-right', { className: 'nested-stream-icon' })
                  : nothing
              }${streamTitle}</span
            >
            <span class="tab-status" aria-hidden="true">
              ${
                statusGlyph
                  ? waIcon(statusGlyph, { className: 'tab-status-icon' })
                  : nothing
              }
              <span class="tab-status-label">${visibleStatusLabel}</span>
            </span>
          </div>
          ${
            this.compact
              ? nothing
              : html`
                  <div id="stream-tab-meta" class="tab-meta">
                    ${
                      metaAgentName
                        ? html`<span class="agent-name">${metaAgentName}</span>`
                        : nothing
                    }
                    ${
                      stream.worktree
                        ? html`<worktree-chip
                            .info=${stream.worktree}
                          ></worktree-chip>`
                        : nothing
                    }
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
                        stream.identity?.kind === 'agent'
                          ? (stream.modelLabel ?? stream.model ?? '')
                          : ''
                      }</span
                    >
                    ${waIcon(streamDecorator.icon, { id: 'stream-tab-kind', className: 'stream-kind' })}
                    ${when(
                      stream.isRemote,
                      () => html`
                        ${waIcon(AGENT_DECORATORS.properties.remote.icon, { id: 'stream-tab-remote', className: 'remote-agent' })}
                      `,
                    )}
                  </div>
                `
          }
        </button>
        ${
          this.compact
            ? nothing
            : html`<wa-tooltip for="stream-tab-kind"
                  >${
                    // Only agent runs have an execution-mode category; other
                    // stream kinds (and pending streams) show their label bare.
                    (stream.identity === undefined ||
                      stream.identity.kind === 'agent') &&
                    stream.agentCategory !== undefined
                      ? `Category: ${streamDecorator.label}`
                      : streamDecorator.label
                  }</wa-tooltip
                >${when(
                  stream.isRemote,
                  () =>
                    html`<wa-tooltip for="stream-tab-remote"
                      >${AGENT_DECORATORS.properties.remote.hint}</wa-tooltip
                    >`,
                )}`
        }
        <wa-button
          id="stream-tab-delete-button"
          class="action-icon-button tab-delete"
          appearance="plain"
          variant="neutral"
          size="s"
          type="button"
          aria-label=${`Delete ${streamTitle}`}
          data-stream=${stream.name}
          data-action="delete"
        >
          ${waIcon('xmark')}
        </wa-button>
        <wa-tooltip for="stream-tab-delete-button">Delete</wa-tooltip>
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
    commonViewStyles,
    layoutStyles,
    streamTabsContainerStyles,
  ];

  @property({ attribute: false }) streams: StreamTabInfo[] = [];
  @property({ type: Boolean, reflect: true }) compact = false;
  @property({ attribute: false }) activeStreamId: string | null = null;
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

  protected override willUpdate(changed: PropertyValues): void {
    if (!changed.has('childStreamsByParent') && !changed.has('streamStates'))
      return;

    const projection = computeStreamTreeProjection({
      streamStates: this.streamStates,
      childStreamsByParent: this.childStreamsByParent,
      userOverrides: this.userOverride,
    });

    this.userOverride = projection.userOverrides;
    if (!setsEqual(projection.expandedParents, this.expandedParents)) {
      this.expandedParents = projection.expandedParents;
    }
  }

  private renderStreamNode(
    stream: StreamTabInfo,
    options: { compact: boolean; visited: Set<string> },
  ): TemplateResult {
    const nextVisited = new Set(options.visited);
    nextVisited.add(stream.name);

    const children = (this.childStreamsByParent.get(stream.name) ?? []).filter(
      (child) => {
        if (nextVisited.has(child.name)) return false;
        // Background bash/process tabs are ephemeral: once terminal, drop
        // them from the Sessions tree even if autoClose has not removed the
        // stream record yet.
        if (child.identity?.kind === 'process') {
          const childStatus = this.streamStates.get(child.name)?.status;
          const phase =
            childStatus === DEFAULT_STREAM_METADATA_STATUS
              ? undefined
              : childStatus;
          if (isTerminalOutcomePhase(phase)) return false;
        }
        return true;
      },
    );
    const childCount = children.length;
    const expanded =
      !options.compact &&
      childCount > 0 &&
      this.expandedParents.has(stream.name);
    const streamState = this.streamStates.get(stream.name);

    return html`
      <stream-tab
        .info=${stream}
        .compact=${options.compact}
        .status=${streamState?.status ?? DEFAULT_STREAM_METADATA_STATUS}
        .substate=${streamState?.substate}
        .lastTimestamp=${streamState?.lastTimestamp}
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
              title: 'No runs yet',
              body: 'Run a TeXRA command to get started.',
              headingTag: 'h3',
              className: 'log-placeholder',
            }),
          )}
        </div>
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
}
