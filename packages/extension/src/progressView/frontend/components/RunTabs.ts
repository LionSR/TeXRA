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

function buildTooltip(run: RunView): string {
  const modelDisplay =
    run.identity.kind === 'agent' && run.model
      ? (run.modelLabel ?? run.model)
      : undefined;
  const worktree = run.worktree;
  const worktreeDisplay = worktree
    ? `Worktree: ${worktree.branch ?? getBasename(worktree.workingDirectory)}`
    : undefined;
  const mainLine = [
    run.label,
    `Status: ${run.approval === 'none' ? run.statusLabel : 'Approval required'}`,
    modelDisplay && `Model: ${modelDisplay}`,
    worktreeDisplay,
  ]
    .filter(Boolean)
    .join(' · ');
  const parts = [mainLine];
  if (run.description) parts.push(run.description);
  if (run.statusDetail) parts.push(run.statusDetail);
  // The opaque id stays in the accessible name: it is what tells two
  // parallel runs of the same agent apart.
  parts.push(run.id);
  if (run.lastTimestamp) {
    const lastSeen = formatRelativeTime(run.lastTimestamp);
    if (lastSeen) parts.push(`Last activity ${lastSeen}`);
  }
  return parts.join('\n');
}

function runDecorator(run: RunView) {
  const kind = run.identity.kind;
  return kind === 'multiAgentWorkflow' || kind === 'process'
    ? AGENT_DECORATORS.streamKinds[kind]
    : getAgentCategoryDecorator(run.category);
}

// =============================================================================
// RunTab: one row
// =============================================================================

/**
 * One run row. Re-renders only when its own `.run` ref or a flag
 * changes; the fold replaces a run's value only when that run changes,
 * so rows of untouched runs skip rendering on every update.
 */
@customElement('run-tab')
class RunTab extends LitElement {
  static override styles = [designTokens, focusRingStyles, runTabStyles];

  @property({ attribute: false }) run!: RunView;
  @property({ type: Boolean }) active = false;
  /** Children are shown beneath this row. */
  @property({ type: Boolean, reflect: true }) expanded = false;
  /** This row has a child list to expand. */
  @property({ type: Boolean }) expandable = false;

  private decorator = getAgentCategoryDecorator('toolUse');

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('run')) this.decorator = runDecorator(this.run);
  }

  override render(): TemplateResult {
    const run = this.run;
    const pendingApproval = run.approval !== 'none';
    const statusGlyph = pendingApproval
      ? 'triangle-exclamation'
      : TONE_ICONS[run.tone];
    const accessibleStatusLabel = pendingApproval
      ? 'Approval required'
      : run.statusLabel;
    const runTitle = run.description || run.label;
    const childCountLabel = formatResultCount(
      run.rollup.total,
      BACKGROUND_TASK.countNoun,
    );
    const childToggleLabel = this.expanded
      ? BACKGROUND_TASK.collapseAction
      : childCountLabel;
    const metaAgentName =
      run.identity.kind === 'agent' && run.description ? run.label : undefined;
    // The rollup is the row's own fact: the rail carries it with no
    // disclosure at all (W2), and a tree row hides it while open.
    const showRollup = run.rollup.total > 0 && !this.expanded;

    return html`
      <div
        class=${classMap({
          'tab-container': true,
          'is-active': this.active,
          [`tone-${run.tone}`]: true,
          'has-pending-approval': pendingApproval,
          'is-read-only': run.readOnly,
        })}
      >
        ${
          this.expandable
            ? html`<wa-button
                  id="run-tab-expand-button"
                  class="action-icon-button tab-expand"
                  appearance="plain"
                  variant="neutral"
                  size="s"
                  type="button"
                  data-run=${run.id}
                  data-action="toggle-children"
                  aria-label=${childToggleLabel}
                  aria-expanded=${this.expanded ? 'true' : 'false'}
                  >${waIcon('chevron-right')}</wa-button
                ><wa-tooltip for="run-tab-expand-button"
                  >${childToggleLabel}</wa-tooltip
                >`
            : nothing
        }
        <div class="tab-select-tooltip-anchor">
          <button
            id="run-tab-select-button"
            class="tab focus-ring-inset"
            data-run=${run.id}
            data-action="select"
            aria-label=${buildTooltip(run)}
          >
            <div class="tab-header">
              <span id="run-tab-title" class="tab-title"
                >${
                  run.parentId
                    ? waIcon('chevron-right', {
                        className: 'nested-run-icon',
                      })
                    : nothing
                }${runTitle}</span
              >
              ${
                showRollup
                  ? html`<span class="tab-rollup" aria-label=${childCountLabel}
                      ><wa-badge variant="neutral" appearance="outlined" pill
                        >${run.rollup.total}</wa-badge
                      >${
                        run.rollup.running > 0
                          ? html`<wa-badge variant="success" pill
                              >${run.rollup.running}</wa-badge
                            >`
                          : nothing
                      }</span
                    >`
                  : nothing
              }
              <span
                id="run-tab-status"
                class="tab-status"
                role="img"
                aria-label=${accessibleStatusLabel}
              >
                ${waIcon(statusGlyph, { className: 'tab-status-icon' })}
              </span>
            </div>
            <div id="run-tab-meta" class="tab-meta">
              ${
                metaAgentName
                  ? html`<span class="agent-name">${metaAgentName}</span>`
                  : nothing
              }
              ${
                run.worktree
                  ? html`<worktree-chip .info=${run.worktree}></worktree-chip>`
                  : nothing
              }
              ${
                run.lastTimestamp
                  ? html`<wa-relative-time
                      class="last-active"
                      .date=${new Date(run.lastTimestamp)}
                      format="narrow"
                      sync
                    ></wa-relative-time>`
                  : nothing
              }
              <span class="model"
                >${
                  run.identity.kind === 'agent'
                    ? (run.modelLabel ?? run.model ?? '')
                    : ''
                }</span
              >
              ${waIcon(this.decorator.icon, { id: 'run-tab-kind', className: 'run-kind' })}
              ${when(
                run.isRemote,
                () => html`
                  ${waIcon(AGENT_DECORATORS.properties.remote.icon, { id: 'run-tab-remote', className: 'remote-agent' })}
                `,
              )}
            </div>
            ${
              run.statusDetail
                ? html`<div class="tab-detail">${run.statusDetail}</div>`
                : nothing
            }
          </button>
          <wa-tooltip for="run-tab-status">${accessibleStatusLabel}</wa-tooltip>
        </div>
        <wa-tooltip for="run-tab-kind"
          >${
            run.identity.kind === 'agent'
              ? `Category: ${this.decorator.label}`
              : this.decorator.label
          }</wa-tooltip
        >${when(
          run.isRemote,
          () =>
            html`<wa-tooltip for="run-tab-remote"
              >${AGENT_DECORATORS.properties.remote.hint}</wa-tooltip
            >`,
        )}
        ${
          run.group === 'interrupted' && !run.readOnly
            ? html`<wa-button
                id="run-tab-resume-button"
                class="tab-resume"
                appearance="outlined"
                variant="brand"
                size="s"
                type="button"
                data-run=${run.id}
                data-action="resume"
                >${waIcon('forward-step', { slot: 'start' })} Resume</wa-button
              >`
            : nothing
        }
        <wa-button
          id="run-tab-delete-button"
          class="action-icon-button tab-delete"
          appearance="plain"
          variant="neutral"
          size="s"
          type="button"
          aria-label=${`Delete ${runTitle}`}
          data-run=${run.id}
          data-action="delete"
        >
          ${waIcon('xmark')}
        </wa-button>
        <wa-tooltip for="run-tab-delete-button">Delete</wa-tooltip>
      </div>
    `;
  }
}

// =============================================================================
// RunTabs: the list
// =============================================================================

@customElement('run-tabs')
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

  private matchesSearch(run: RunView, needle: string): boolean {
    if (needle === '') return true;
    return (
      run.label.toLowerCase().includes(needle) ||
      (run.description?.toLowerCase().includes(needle) ?? false) ||
      run.childIds.some((id) => {
        const child = this.runOfEvent(id);
        return child !== undefined && this.matchesSearch(child, needle);
      })
    );
  }

  private isExpanded(run: RunView): boolean {
    if (run.forceExpanded) return true;
    return this.surface?.expanded.get(run.id) === true;
  }

  /** The tree under a row, at any depth. The rail (`topLevelOnly`) shows
   *  none and carries the rollup alone (W2); the drawer and the Subagents
   *  pane show every child, a workflow run's calls included, so a call's
   *  own subagents stay reachable under their parent (issue decision). */
  private childrenOf(run: RunView): RunView[] {
    if (this.topLevelOnly) return [];
    return run.childIds
      .map((id) => this.runOfEvent(id))
      .filter((child): child is RunView => child !== undefined);
  }

  private renderNode(run: RunView, selected: RunId | null): TemplateResult {
    const children = this.childrenOf(run);
    const expandable = children.length > 0;
    const expanded = expandable && this.isExpanded(run);
    return html`
      <run-tab
        .run=${run}
        ?active=${run.id === selected}
        ?expandable=${expandable}
        ?expanded=${expanded}
      ></run-tab>
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
        const run = this.runOfEvent(id);
        return run ? this.renderNode(run, selected) : nothing;
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
      .filter((run): run is RunView => run !== undefined)
      .filter((run) => !this.activeOnly || run.group !== 'recent')
      .filter((run) => this.matchesSearch(run, needle));

    let body: TemplateResult;
    if (!this.sections) {
      body = this.renderRows(
        top.map((run) => run.id),
        selected,
      );
    } else {
      body = html`${RUN_GROUP_ORDER.map((group) => {
        const rows = top.filter((run) => run.group === group);
        if (rows.length === 0) return nothing;
        return html`<div class="group-heading group-${group}">
            <span>${RUN_GROUP_LABELS[group]}</span>
            <span class="group-count">${rows.length}</span>
          </div>
          ${this.renderRows(
            rows.map((run) => run.id),
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
      '[data-run][data-action]',
    );
    if (!(actionElement instanceof HTMLElement)) return;

    // The action element lives in the row's own `run-tab`, whose `run`
    // is the typed view: the id is read from it, never re-parsed from the DOM.
    const tab = getComposedPathElement<RunTab>(event, 'run-tab');
    const run = tab?.run;
    if (!run) return;
    const runId = run.id;
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
            expanded: !this.isExpanded(run),
          }),
        );
        break;
    }
  }
}
