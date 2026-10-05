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
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports
import type { SessionView, RunView } from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';
import { unseenRuns } from '@shared/session/unseenRuns';
import {
  RUN_GROUP_LABELS,
  RUN_GROUP_ORDER,
} from '@shared/runs/runStatusDisplay';
import { SessionUiEvents } from '@texra/shared/session/uiEvents';
import { designTokens, commonViewStyles } from '@ui/styles';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import './WorktreeChip';
import { renderEmptyState } from '@ui/wa/emptyState';
import { layoutStyles } from '../styles/logStyles';
import { runTabsContainerStyles } from './RunTabsContainer.styles';
import { getComposedPathElement } from '../utils';
import type { RunId } from '@texra-ai/harness/schemas';
import type { RunTab } from './RunTab';
import './RunTab';

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

  /** Runs that finished since the surface last showed them, read once per
   *  render and marked on their rows. */
  private unseen: ReadonlySet<RunId> = new Set();
  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  /** Only top-level rows, no tree: the Active-now strip and the desktop
   *  rail. */
  @property({ type: Boolean }) topLevelOnly = false;
  /** Streams that need the user or are still running; `recent` is left
   *  out. */
  @property({ type: Boolean }) activeOnly = false;
  /** Group headings (Running, Waiting on you, Interrupted, Recent). */
  @property({ type: Boolean }) sections = false;
  /** Rows offer an immediate Delete: the desktop rail. */
  @property({ type: Boolean }) removable = false;

  /** Deletes sent from a row's ×, still in flight: another click on the
   *  same row sends nothing. An id leaves once its row is gone from the
   *  view or the surface records the refusal. */
  private readonly deleting = new Set<RunId>();
  /** The row to focus once the deleted row, which held focus, is gone. */
  private focusAfterDelete: { runId: RunId; next: RunTab | undefined } | null =
    null;

  protected override willUpdate(changed: PropertyValues): void {
    if (!changed.has('view') && !changed.has('surface')) return;
    for (const runId of this.deleting) {
      if (!this.view?.runs.has(runId) || this.surface?.rejected.has(runId)) {
        this.deleting.delete(runId);
      }
    }
  }

  protected override updated(): void {
    const pending = this.focusAfterDelete;
    if (pending === null || this.deleting.has(pending.runId)) return;
    this.focusAfterDelete = null;
    if (!this.view?.runs.has(pending.runId) && pending.next?.isConnected) {
      pending.next.focus();
    }
  }

  private deleteRun(tab: RunTab, runId: RunId): void {
    if (this.deleting.has(runId)) return;
    this.deleting.add(runId);
    if (tab.matches(':focus-within')) {
      const rows = [...this.renderRoot.querySelectorAll<RunTab>('run-tab')];
      const at = rows.indexOf(tab);
      this.focusAfterDelete = { runId, next: rows[at + 1] ?? rows[at - 1] };
    }
    this.dispatchEvent(SessionUiEvents.runtime({ kind: 'run.delete', runId }));
  }

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
   *  none and carries the rollup alone (W2); the drawer and the docked
   *  list show every child, a workflow run's calls included, so a call's
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
        ?unseen=${this.unseen.has(run.id)}
        .unread=${this.view?.queuedFollowUps.get(run.id)?.length ?? 0}
        ?expandable=${expandable}
        ?expanded=${expanded}
        ?removable=${this.removable && run.actions.includes('delete')}
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
    runs: readonly RunView[],
    selected: RunId | null,
  ): TemplateResult {
    return html`${repeat(
      runs,
      (run) => run.id,
      (run) => this.renderNode(run, selected),
    )}`;
  }

  override render(): TemplateResult {
    const view = this.view;
    const surface = this.surface;
    const selected = surface?.selected ?? null;
    this.unseen = view && surface ? unseenRuns(surface, view) : new Set();
    const needle = (surface?.search ?? '').trim().toLowerCase();
    const top = (view?.order ?? [])
      .map((id) => this.runOfEvent(id))
      .filter((run): run is RunView => run !== undefined)
      .filter((run) => !this.activeOnly || run.group !== 'recent')
      .filter((run) => this.matchesSearch(run, needle));

    let body: TemplateResult;
    if (!this.sections) {
      body = this.renderRows(top, selected);
    } else {
      body = html`${RUN_GROUP_ORDER.map((group) => {
        const rows = top.filter((run) => run.group === group);
        if (rows.length === 0) return nothing;
        return html`<div class="group-heading group-${group}">
            <span>${RUN_GROUP_LABELS[group]}</span>
            <span class="group-count">${rows.length}</span>
          </div>
          ${this.renderRows(rows, selected)}`;
      })}`;
    }

    return html`
      <div class="tabs">
        <div class="tabs-content">
          <div @click=${this.handleTabClick}>${body}</div>
          ${when((view?.order.length ?? 0) === 0, () =>
            renderEmptyState({
              icon: 'list-ul',
              title: 'No tasks yet',
              body: 'Tasks you start appear here.',
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
    if (!tab || !run) return;
    const runId = run.id;
    const { action } = actionElement.dataset;

    switch (action) {
      case 'select':
        this.dispatchEvent(SessionUiEvents.surface({ kind: 'select', runId }));
        break;
      case 'delete':
        this.deleteRun(tab, runId);
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
