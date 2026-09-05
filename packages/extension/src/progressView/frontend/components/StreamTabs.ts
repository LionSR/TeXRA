// Third-party imports
import {
  LitElement,
  css,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import { resolveSelected, type Surface } from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { focusRingStyles } from '@shared/styles/controlStyles';
import { AGENT_DECORATORS, getAgentCategoryDecorator } from '@shared/wa/icons';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import './WorktreeChip';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { type TeXRAIconName } from '@shared/wa/iconNames';
import { renderEmptyState } from '@shared/wa/emptyState';
import { BACKGROUND_TASK } from '@shared/copy/nestedRuns';
import { getBasename } from '@utils/core';
import { formatRelativeTime, formatResultCount } from '@utils/text/stringUtils';
import { layoutStyles } from '../styles/logStyles';
import { streamTabStyles } from './StreamTab.styles';
import { streamTabsContainerStyles } from './StreamTabsContainer.styles';
import { ELEMENT_IDS } from '../constants';
import { getComposedPathElement } from '../utils';

/** Shape cue per tone (G4: the fold spells the tone, the host the glyph). */
const TONE_ICONS: Record<StreamView['tone'], TeXRAIconName> = {
  running: 'play',
  success: 'circle-check',
  danger: 'circle-exclamation',
  warning: 'triangle-exclamation',
  neutral: 'circle',
};

/** One section per `group` arm, in union order. */
const GROUP_LABELS: Record<StreamView['group'], string> = {
  running: 'Running',
  waiting: 'Waiting on you',
  interrupted: 'Interrupted',
  recent: 'Recent',
};
const GROUP_ORDER = Object.keys(GROUP_LABELS) as StreamView['group'][];

function buildTooltip(stream: StreamView): string {
  const modelDisplay =
    stream.identity?.kind === 'agent' && stream.model
      ? (stream.modelLabel ?? stream.model)
      : undefined;
  const worktree = stream.worktree;
  const worktreeDisplay = worktree
    ? `Worktree: ${worktree.branch ?? getBasename(worktree.workingDirectory)}`
    : undefined;
  const mainLine = [
    stream.label,
    `Status: ${stream.approval === 'none' ? stream.statusLabel : 'Approval required'}`,
    modelDisplay && `Model: ${modelDisplay}`,
    worktreeDisplay,
  ]
    .filter(Boolean)
    .join(' · ');
  const parts = [mainLine];
  if (stream.description) parts.push(stream.description);
  if (stream.statusDetail) parts.push(stream.statusDetail);
  // The opaque id stays in the accessible name: it is what tells two
  // parallel runs of the same agent apart.
  parts.push(stream.id);
  if (stream.lastTimestamp) {
    const lastSeen = formatRelativeTime(stream.lastTimestamp);
    if (lastSeen) parts.push(`Last activity ${lastSeen}`);
  }
  return parts.join('\n');
}

function streamDecorator(stream: StreamView) {
  const kind = stream.identity?.kind;
  return kind === 'multiAgentWorkflow' || kind === 'process'
    ? AGENT_DECORATORS.streamKinds[kind]
    : getAgentCategoryDecorator(stream.category);
}

// =============================================================================
// StreamTab: one row
// =============================================================================

/**
 * One stream row. Re-renders only when its own `.stream` ref or a flag
 * changes; the fold replaces a stream's value only when that stream changes,
 * so rows of untouched streams skip rendering on every update.
 */
@customElement('stream-tab')
class StreamTab extends LitElement {
  static override styles = [designTokens, focusRingStyles, streamTabStyles];

  @property({ attribute: false }) stream!: StreamView;
  @property({ type: Boolean }) active = false;
  /** Children are shown beneath this row. */
  @property({ type: Boolean, reflect: true }) expanded = false;
  /** This row has a child list to expand. */
  @property({ type: Boolean }) expandable = false;

  private decorator = getAgentCategoryDecorator('toolUse');

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('stream')) this.decorator = streamDecorator(this.stream);
  }

  override render(): TemplateResult {
    const stream = this.stream;
    const pendingApproval = stream.approval !== 'none';
    const statusGlyph = pendingApproval
      ? 'triangle-exclamation'
      : TONE_ICONS[stream.tone];
    const accessibleStatusLabel = pendingApproval
      ? 'Approval required'
      : stream.statusLabel;
    const streamTitle = stream.description || stream.label;
    const childCountLabel = formatResultCount(
      stream.rollup.total,
      BACKGROUND_TASK.countNoun,
    );
    const childToggleLabel = this.expanded
      ? BACKGROUND_TASK.collapseAction
      : childCountLabel;
    const metaAgentName =
      stream.identity?.kind === 'agent' && stream.description
        ? stream.label
        : undefined;
    const showRollup = this.expandable && !this.expanded;

    return html`
      <div
        class=${classMap({
          'tab-container': true,
          'is-active': this.active,
          [`tone-${stream.tone}`]: true,
          'has-pending-approval': pendingApproval,
          'is-read-only': stream.readOnly,
        })}
      >
        ${
          this.expandable
            ? html`<wa-button
                  id="stream-tab-expand-button"
                  class="action-icon-button tab-expand"
                  appearance="plain"
                  variant="neutral"
                  size="s"
                  type="button"
                  data-stream=${stream.id}
                  data-action="toggle-children"
                  aria-label=${childToggleLabel}
                  aria-expanded=${this.expanded ? 'true' : 'false'}
                  >${waIcon('chevron-right')}</wa-button
                ><wa-tooltip for="stream-tab-expand-button"
                  >${childToggleLabel}</wa-tooltip
                >`
            : nothing
        }
        <div class="tab-select-tooltip-anchor">
          <button
            id="stream-tab-select-button"
            class="tab focus-ring-inset"
            data-stream=${stream.id}
            data-action="select"
            aria-label=${buildTooltip(stream)}
          >
            <div class="tab-header">
              <span id="stream-tab-title" class="tab-title"
                >${
                  stream.parentId
                    ? waIcon('chevron-right', {
                        className: 'nested-stream-icon',
                      })
                    : nothing
                }${streamTitle}</span
              >
              ${
                showRollup
                  ? html`<span class="tab-rollup" aria-label=${childCountLabel}
                      ><wa-badge variant="neutral" appearance="outlined" pill
                        >${stream.rollup.total}</wa-badge
                      >${
                        stream.rollup.running > 0
                          ? html`<wa-badge variant="success" pill
                              >${stream.rollup.running}</wa-badge
                            >`
                          : nothing
                      }</span
                    >`
                  : nothing
              }
              <span
                id="stream-tab-status"
                class="tab-status"
                role="img"
                aria-label=${accessibleStatusLabel}
              >
                ${waIcon(statusGlyph, { className: 'tab-status-icon' })}
              </span>
            </div>
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
                stream.lastTimestamp
                  ? html`<wa-relative-time
                      class="last-active"
                      .date=${new Date(stream.lastTimestamp)}
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
              ${waIcon(this.decorator.icon, { id: 'stream-tab-kind', className: 'stream-kind' })}
              ${when(
                stream.isRemote,
                () => html`
                  ${waIcon(AGENT_DECORATORS.properties.remote.icon, { id: 'stream-tab-remote', className: 'remote-agent' })}
                `,
              )}
            </div>
            ${
              stream.statusDetail
                ? html`<div class="tab-detail">${stream.statusDetail}</div>`
                : nothing
            }
          </button>
          <wa-tooltip for="stream-tab-status"
            >${accessibleStatusLabel}</wa-tooltip
          >
        </div>
        <wa-tooltip for="stream-tab-kind"
          >${
            stream.identity === null || stream.identity.kind === 'agent'
              ? `Category: ${this.decorator.label}`
              : this.decorator.label
          }</wa-tooltip
        >${when(
          stream.isRemote,
          () =>
            html`<wa-tooltip for="stream-tab-remote"
              >${AGENT_DECORATORS.properties.remote.hint}</wa-tooltip
            >`,
        )}
        ${
          stream.group === 'interrupted' && !stream.readOnly
            ? html`<wa-button
                id="stream-tab-resume-button"
                class="tab-resume"
                appearance="outlined"
                variant="brand"
                size="s"
                type="button"
                data-stream=${stream.id}
                data-action="resume"
                >${waIcon('forward-step', { slot: 'start' })} Resume</wa-button
              >`
            : nothing
        }
        <wa-button
          id="stream-tab-delete-button"
          class="action-icon-button tab-delete"
          appearance="plain"
          variant="neutral"
          size="s"
          type="button"
          aria-label=${`Delete ${streamTitle}`}
          data-stream=${stream.id}
          data-action="delete"
          ?disabled=${stream.readOnly}
        >
          ${waIcon('xmark')}
        </wa-button>
        <wa-tooltip for="stream-tab-delete-button">Delete</wa-tooltip>
      </div>
    `;
  }
}

// =============================================================================
// StreamTabs: the list
// =============================================================================

@customElement('stream-tabs')
export class StreamTabs extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    layoutStyles,
    streamTabsContainerStyles,
    css`
      .group-heading {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-xs) var(--wa-space-xs) var(--wa-space-3xs);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        letter-spacing: 0.02em;
        text-transform: uppercase;
        color: var(--color-text-secondary);
      }
      .group-heading .group-count {
        font-weight: var(--font-weight-normal);
        color: var(--color-text-muted);
      }
      .group-heading.group-waiting {
        color: var(--color-warning);
      }
      .group-heading.group-interrupted {
        color: var(--color-warning);
      }
    `,
  ];

  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  /** Only top-level rows, no tree: the Active-now strip and the desktop
   *  rail whose workbench Subagents tab owns the tree. */
  @property({ type: Boolean }) topLevelOnly = false;
  /** Streams that need the user or are still running; `recent` is left
   *  out. */
  @property({ type: Boolean }) activeOnly = false;
  /** Group headings (Running, Waiting on you, Interrupted, Recent). */
  @property({ type: Boolean }) sections = false;
  /** The subtree to show instead of `view.order`: the Subagents pane. */
  @property({ attribute: false }) root: StreamTabId | null = null;

  private streamOf(id: StreamTabId): StreamView | undefined {
    return this.view?.streams.get(id);
  }

  private matchesSearch(stream: StreamView, needle: string): boolean {
    if (needle === '') return true;
    return (
      stream.label.toLowerCase().includes(needle) ||
      (stream.description?.toLowerCase().includes(needle) ?? false) ||
      stream.childIds.some((id) => {
        const child = this.streamOf(id);
        return child !== undefined && this.matchesSearch(child, needle);
      })
    );
  }

  private isExpanded(stream: StreamView): boolean {
    if (stream.forceExpanded) return true;
    return this.surface?.expanded.get(stream.id) === 'expanded';
  }

  /** A workflow run's calls live on its run board, never in the list: the
   *  root row alone carries their rollup (W2). */
  private childrenOf(stream: StreamView): StreamView[] {
    if (this.topLevelOnly || stream.category === AgentCategory.Workflow) {
      return [];
    }
    return stream.childIds
      .map((id) => this.streamOf(id))
      .filter((child): child is StreamView => child !== undefined);
  }

  private renderNode(
    stream: StreamView,
    selected: StreamTabId | null,
  ): TemplateResult {
    const children = this.childrenOf(stream);
    const expandable = children.length > 0;
    const expanded = expandable && this.isExpanded(stream);
    return html`
      <stream-tab
        .stream=${stream}
        ?active=${stream.id === selected}
        ?expandable=${expandable || (this.topLevelOnly && stream.rollup.total > 0)}
        ?expanded=${expanded}
      ></stream-tab>
      ${
        expandable
          ? html`<div class="child-streams" ?hidden=${!expanded}>
              ${repeat(
                children,
                (child) => child.id,
                (child) => this.renderNode(child, selected),
              )}
            </div>`
          : nothing
      }
    `;
  }

  private renderRows(
    ids: readonly StreamTabId[],
    selected: StreamTabId | null,
  ): TemplateResult {
    return html`${repeat(
      ids,
      (id) => id,
      (id) => {
        const stream = this.streamOf(id);
        return stream ? this.renderNode(stream, selected) : nothing;
      },
    )}`;
  }

  override render(): TemplateResult {
    const view = this.view;
    const surface = this.surface;
    const selected = view && surface ? resolveSelected(view, surface) : null;
    const needle = (surface?.search ?? '').trim().toLowerCase();
    const rootStream =
      this.root === null ? undefined : this.streamOf(this.root);
    const top = (rootStream ? [rootStream.id] : (view?.order ?? []))
      .map((id) => this.streamOf(id))
      .filter((stream): stream is StreamView => stream !== undefined)
      .filter((stream) => !this.activeOnly || stream.group !== 'recent')
      .filter((stream) => this.matchesSearch(stream, needle));

    let body: TemplateResult;
    if (!this.sections) {
      body = this.renderRows(
        top.map((stream) => stream.id),
        selected,
      );
    } else {
      body = html`${GROUP_ORDER.map((group) => {
        const rows = top.filter((stream) => stream.group === group);
        if (rows.length === 0) return nothing;
        return html`<div class="group-heading group-${group}">
            <span>${GROUP_LABELS[group]}</span>
            <span class="group-count">${rows.length}</span>
          </div>
          ${this.renderRows(
            rows.map((stream) => stream.id),
            selected,
          )}`;
      })}`;
    }

    return html`
      <div class="tabs">
        <div class="tabs-content">
          <div id=${ELEMENT_IDS.STREAM_TABS} @click=${this.handleTabClick}>
            ${body}
          </div>
          ${when((view?.order.length ?? 0) === 0, () =>
            renderEmptyState({
              icon: 'terminal',
              title: 'No runs yet',
              body: 'Start a task to see it here.',
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
        this.dispatchEvent(
          SessionUiEvents.surface({ kind: 'select', streamId }),
        );
        break;
      case 'delete':
        this.dispatchEvent(
          SessionUiEvents.runtime({ kind: 'stream.delete', streamId }),
        );
        break;
      case 'resume':
        this.dispatchEvent(SessionUiEvents.host({ kind: 'resume', streamId }));
        break;
      case 'toggle-children': {
        const stream = this.streamOf(streamId);
        if (!stream) return;
        if (this.topLevelOnly) {
          // The rail owns no tree here; the Subagents pane does. Selecting
          // the row is the navigation.
          this.dispatchEvent(
            SessionUiEvents.surface({ kind: 'select', streamId }),
          );
          return;
        }
        this.dispatchEvent(
          SessionUiEvents.surface({
            kind: 'expand',
            streamId,
            override: this.isExpanded(stream) ? 'collapsed' : 'expanded',
          }),
        );
        break;
      }
    }
  }
}
