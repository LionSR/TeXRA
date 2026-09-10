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
import type { RunId } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import type { SessionView, RunView } from '@shared/session/sessionView';
import { resolveSelected, type Surface } from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import {
  RUN_GROUP_LABELS,
  RUN_GROUP_ORDER,
} from '@shared/runs/runStatusDisplay';
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
import { runTabStyles } from './RunTab.styles';
import { runTabsContainerStyles } from './RunTabsContainer.styles';
import { ELEMENT_IDS } from '../constants';
import { getComposedPathElement } from '../utils';

/** Shape cue per tone (G4: the fold spells the tone, the host the glyph). */
const TONE_ICONS: Record<RunView['tone'], TeXRAIconName> = {
  running: 'play',
  success: 'circle-check',
  danger: 'circle-exclamation',
  warning: 'triangle-exclamation',
  neutral: 'circle',
};

function buildTooltip(stream: RunView): string {
  const modelDisplay =
    stream.identity.kind === 'agent' && stream.model
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

function runDecorator(stream: RunView) {
  const kind = stream.identity.kind;
  return kind === 'multiAgentWorkflow' || kind === 'process'
    ? AGENT_DECORATORS.streamKinds[kind]
    : getAgentCategoryDecorator(stream.category);
}

// =============================================================================
// RunTab: one row
// =============================================================================

/**
 * One stream row. Re-renders only when its own `.stream` ref or a flag
 * changes; the fold replaces a stream's value only when that stream changes,
 * so rows of untouched runs skip rendering on every update.
 */
@customElement('stream-tab')
class RunTab extends LitElement {
  static override styles = [designTokens, focusRingStyles, runTabStyles];

  @property({ attribute: false }) stream!: RunView;
  @property({ type: Boolean }) active = false;
  /** Children are shown beneath this row. */
  @property({ type: Boolean, reflect: true }) expanded = false;
  /** This row has a child list to expand. */
  @property({ type: Boolean }) expandable = false;

  private decorator = getAgentCategoryDecorator('toolUse');

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('stream')) this.decorator = runDecorator(this.stream);
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
    const runTitle = stream.description || stream.label;
    const childCountLabel = formatResultCount(
      stream.rollup.total,
      BACKGROUND_TASK.countNoun,
    );
    const childToggleLabel = this.expanded
      ? BACKGROUND_TASK.collapseAction
      : childCountLabel;
    const metaAgentName =
      stream.identity.kind === 'agent' && stream.description
        ? stream.label
        : undefined;
    // The rollup is the row's own fact: the rail carries it with no
    // disclosure at all (W2), and a tree row hides it while open.
    const showRollup = stream.rollup.total > 0 && !this.expanded;

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
                }${runTitle}</span
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
                  stream.identity.kind === 'agent'
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
            stream.identity.kind === 'agent'
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
          aria-label=${`Delete ${runTitle}`}
          data-stream=${stream.id}
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
// RunTabs: the list
// =============================================================================

@customElement('stream-tabs')
export class RunTabs extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    layoutStyles,
    runTabsContainerStyles,
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
  @property({ attribute: false }) root: RunId | null = null;

  private runOfEvent(id: RunId): RunView | undefined {
    return this.view?.runs.get(id);
  }

  private matchesSearch(stream: RunView, needle: string): boolean {
    if (needle === '') return true;
    return (
      stream.label.toLowerCase().includes(needle) ||
      (stream.description?.toLowerCase().includes(needle) ?? false) ||
      stream.childIds.some((id) => {
        const child = this.runOfEvent(id);
        return child !== undefined && this.matchesSearch(child, needle);
      })
    );
  }

  private isExpanded(stream: RunView): boolean {
    if (stream.forceExpanded) return true;
    return this.surface?.expanded.get(stream.id) === true;
  }

  /** The tree under a row, at any depth. The rail (`topLevelOnly`) shows
   *  none and carries the rollup alone (W2); the drawer and the Subagents
   *  pane show every child, a workflow run's calls included, so a call's
   *  own subagents stay reachable under their parent (issue decision). */
  private childrenOf(stream: RunView): RunView[] {
    if (this.topLevelOnly) return [];
    return stream.childIds
      .map((id) => this.runOfEvent(id))
      .filter((child): child is RunView => child !== undefined);
  }

  private renderNode(stream: RunView, selected: RunId | null): TemplateResult {
    const children = this.childrenOf(stream);
    const expandable = children.length > 0;
    const expanded = expandable && this.isExpanded(stream);
    return html`
      <stream-tab
        .stream=${stream}
        ?active=${stream.id === selected}
        ?expandable=${expandable}
        ?expanded=${expanded}
      ></stream-tab>
      ${
        expandable
          ? html`<div class="child-runs" ?hidden=${!expanded}>
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
    ids: readonly RunId[],
    selected: RunId | null,
  ): TemplateResult {
    return html`${repeat(
      ids,
      (id) => id,
      (id) => {
        const stream = this.runOfEvent(id);
        return stream ? this.renderNode(stream, selected) : nothing;
      },
    )}`;
  }

  override render(): TemplateResult {
    const view = this.view;
    const surface = this.surface;
    const selected = view && surface ? resolveSelected(view, surface) : null;
    const needle = (surface?.search ?? '').trim().toLowerCase();
    const rootRun = this.root === null ? undefined : this.runOfEvent(this.root);
    const top = (rootRun ? [rootRun.id] : (view?.order ?? []))
      .map((id) => this.runOfEvent(id))
      .filter((stream): stream is RunView => stream !== undefined)
      .filter((stream) => !this.activeOnly || stream.group !== 'recent')
      .filter((stream) => this.matchesSearch(stream, needle));

    let body: TemplateResult;
    if (!this.sections) {
      body = this.renderRows(
        top.map((stream) => stream.id),
        selected,
      );
    } else {
      body = html`${RUN_GROUP_ORDER.map((group) => {
        const rows = top.filter((stream) => stream.group === group);
        if (rows.length === 0) return nothing;
        return html`<div class="group-heading group-${group}">
            <span>${RUN_GROUP_LABELS[group]}</span>
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

    // The action element lives in the row's own `stream-tab`, whose `stream`
    // is the typed view: the id is read from it, never re-parsed from the DOM.
    const tab = getComposedPathElement<RunTab>(event, 'stream-tab');
    const stream = tab?.stream;
    if (!stream) return;
    const runId = stream.id;
    const { action } = actionElement.dataset;

    switch (action) {
      case 'select':
        this.dispatchEvent(SessionUiEvents.surface({ kind: 'select', runId }));
        break;
      case 'delete':
        this.dispatchEvent(
          SessionUiEvents.runtime({ kind: 'run.delete', runId }),
        );
        break;
      case 'resume':
        this.dispatchEvent(SessionUiEvents.host({ kind: 'resume', runId }));
        break;
      case 'toggle-children':
        this.dispatchEvent(
          SessionUiEvents.surface({
            kind: 'expand',
            runId,
            expanded: !this.isExpanded(stream),
          }),
        );
        break;
    }
  }
}
