// Third-party imports
import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports
import {
  runExpanded,
  shownRun,
  type Surface,
} from '@texra/shared/session/surface';
import { unseenRuns } from '@texra/shared/session/unseenRuns';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { EMPTY_TASK_LIST } from '@ui/copy/nestedRuns';
import { runListSections, runStatus } from '@ui/copy/runStatus';
import { overlineDeclarations } from '@ui/styles/commonViewStyles';
import { TexraElement } from '@ui/litBase';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import './WorktreeChip';
import { renderEmptyState } from '@ui/wa/emptyState';
import { matchesQuery } from '@ui/wa/listInteraction';
import { layoutStyles } from '../styles/logStyles';
import { runTabsContainerStyles } from './RunTabsContainer.styles';
import { getComposedPathElement } from './composedPath';
import { RunTab } from './RunTab';
import {
  type SessionView,
  type RunView,
  type RunId,
} from '@texra-ai/worldline/schemas';

// =============================================================================
// RunTabs: the list
// =============================================================================

@customElement('run-tabs')
export class RunTabs extends TexraElement {
  static override styles = [
    TexraElement.styles,
    layoutStyles,
    runTabsContainerStyles,
    css`
      .group-heading {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-xs) var(--wa-space-xs) var(--wa-space-3xs);
        ${overlineDeclarations}
      }
      .group-heading .group-count {
        font-weight: var(--font-weight-normal);
        color: var(--color-text-secondary);
      }
      .group-heading:is(.group-waiting, .group-interrupted) {
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

  /** The row to focus once the deleted row, which held focus, is gone. */
  private focusAfterDelete: { runId: RunId; next: RunTab | undefined } | null =
    null;

  /** Focus moves on once the deleted row leaves the view; a delete that
   *  ended with the row still there (the surface shows its rejection)
   *  keeps focus where it is. */
  protected override updated(): void {
    const pending = this.focusAfterDelete;
    if (pending === null) return;
    if (this.view?.runs.has(pending.runId)) {
      const ended =
        !this.surface?.deleting.has(pending.runId) &&
        this.surface?.runs.get(pending.runId)?.rejected !== undefined;
      if (ended) this.focusAfterDelete = null;
      return;
    }
    this.focusAfterDelete = null;
    if (pending.next?.isConnected) pending.next.focus();
  }

  /** The surfaces send nothing while this run's delete is in flight. */
  private deleteRun(tab: RunTab, runId: RunId): void {
    if (this.surface?.deleting.has(runId)) return;
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

  /** A run is listed when it or any run under it matches the filter. */
  private matchesSearch(run: RunView, query: string): boolean {
    return (
      matchesQuery(`${run.label} ${run.description ?? ''}`, query) ||
      run.childIds.some((id) => {
        const child = this.runOfEvent(id);
        return child !== undefined && this.matchesSearch(child, query);
      })
    );
  }

  private isExpanded(run: RunView): boolean {
    if (this.view === null) return false;
    return runExpanded(this.surface ?? { runs: new Map() }, this.view, run);
  }

  /** The tree under a row, at any depth. The rail (`topLevelOnly`) shows
   *  none and carries the rollup alone, with no disclosure; the drawer and
   *  the docked list show every child, a document task run's calls
   *  included, so a call's own subagents stay reachable under their
   *  parent. */
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
        .unread=${run.queuedFollowUps.length}
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
    const selected = surface ? shownRun(surface) : null;
    this.unseen = view && surface ? unseenRuns(surface, view) : new Set();
    const query = surface?.search ?? '';
    const top = (view?.order ?? [])
      .map((id) => this.runOfEvent(id))
      .filter((run): run is RunView => run !== undefined)
      .filter((run) => !this.activeOnly || runStatus(run).section !== 'recent')
      .filter((run) => this.matchesSearch(run, query));

    let body: TemplateResult;
    if (!this.sections) {
      body = this.renderRows(top, selected);
    } else {
      body = html`${runListSections(top).map(
        ({ section, label, runs }) =>
          html`<div class="group-heading group-${section}">
              <span>${label}</span>
              <span class="group-count">${runs.length}</span>
            </div>
            ${this.renderRows(runs, selected)}`,
      )}`;
    }

    return html`
      <div class="tabs">
        <div class="tabs-content">
          <div
            @click=${this.handleTabClick}
            @run-row-delete=${(event: Event) => {
              const tab = getComposedPathElement(event, 'run-tab', RunTab);
              if (tab && this.removable && tab.run.actions.includes('delete'))
                this.deleteRun(tab, tab.run.id);
            }}
          >
            ${body}
          </div>
          ${when((view?.order.length ?? 0) === 0, () =>
            renderEmptyState({
              icon: 'list-ul',
              title: EMPTY_TASK_LIST.title,
              body: EMPTY_TASK_LIST.body,
              headingTag: 'h3',
            }),
          )}
        </div>
      </div>
    `;
  }

  private handleTabClick(event: MouseEvent): void {
    const actionElement = getComposedPathElement(
      event,
      '[data-run][data-action]',
      HTMLElement,
    );
    if (!actionElement) return;

    // The action element lives in the row's own `run-tab`, whose `run`
    // is the typed view: the id is read from it, never re-parsed from the DOM.
    const tab = getComposedPathElement(event, 'run-tab', RunTab);
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
