/**
 * The dispatch card: what a run has fanned out, in its
 * conversation prelude. A `<wa-details>` headed by the counts of what it
 * lists, each kind by its noun ("3 agents, 4 commands in the background"),
 * with how many of them still run as a badge and "since <time>" from the
 * earliest child still running (the session view clears `runStartedAt` when
 * a run ends, so a finished fan-out carries no since), one row per
 * dispatched child run (`dispatchedChildren`: a script's calls are listed by
 * its stage; nested children indented under theirs). Every row is a
 * child of the session view: label, status, tone, latest line, and clock
 * facts come from `view.runs`; the host paints the glyph and the time. The
 * card's open state is the surface's (`RunSurface.disclosures`, key
 * {@link DISPATCH_GROUP_KEY}); a toggle goes out as a `group` action.
 * Selecting a row is the navigation.
 */

// Third-party imports
import { html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA components used by this template
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';

// Local imports
import {
  rollupOf,
  type RunId,
  formatCompactDuration,
} from '@texra-ai/harness/schemas';
import { dispatchedChildren } from '@texra-ai/harness/transcript';
import type { Surface } from '@texra/shared/session/surface';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { TickerController } from '@ui/litControllers/TickerController';
import { runStatus } from '@ui/copy/runStatus';
import { TexraElement } from '@ui/litBase';
import { toneStyles } from '@ui/styles/toneStyles';
import { truncateDeclarations } from '@ui/styles/commonViewStyles';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { dispatchSummary, nestedCountsLabel } from '@ui/copy/nestedRuns';
import { getTimeFormatter } from '../formatters/timestampUtils';
import { dispatchDisclosureToggle } from './disclosureToggle';
import type { SessionView, RunView } from '@texra-ai/harness/schemas';

/** The card's key in `RunSurface.disclosures` for its run. */
const DISPATCH_GROUP_KEY = 'dispatch';

@customElement('background-tasks-panel')
export class BackgroundTasksPanel extends TexraElement {
  static override styles = [
    TexraElement.styles,
    toneStyles,
    css`
      :host {
        display: block;
      }

      wa-details.dispatch::part(base) {
        border-radius: var(--border-radius-large);
      }
      wa-details.dispatch::part(header) {
        padding: var(--wa-space-xs) var(--wa-space-s);
      }
      wa-details.dispatch::part(content) {
        padding: 0 var(--wa-space-2xs) var(--wa-space-2xs);
      }

      .dispatch-summary {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        min-width: 0;
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
      }
      .dispatch-summary wa-icon {
        color: var(--wa-color-brand-on-quiet);
      }
      .dispatch-summary wa-badge::part(base) {
        font-size: var(--font-size-xs);
        line-height: var(--line-height-tight);
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
      }
      .dispatch-since {
        font-weight: var(--font-weight-normal);
        font-variant-numeric: tabular-nums;
        color: var(--color-text-secondary);
      }

      .task-list {
        display: flex;
        flex-direction: column;
      }

      /* One row per child: the tone glyph, the label, the latest line, the
         clock, the chevron. Selecting the row opens the child. */
      .task-row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        width: 100%;
        min-height: 1.75rem;
        padding: var(--wa-space-3xs) var(--wa-space-xs);
        padding-inline-start: calc(
          var(--wa-space-xs) + var(--tree-depth, 0) * var(--wa-space-m)
        );
        border: 0;
        border-radius: var(--border-radius-small);
        background: transparent;
        font: inherit;
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-normal);
        text-align: start;
        cursor: pointer;
      }
      .task-row:hover {
        background: var(--surface-hover);
      }

      .task-icon {
        flex-shrink: 0;
        font-size: var(--font-size-sm);
        color: var(--tone-color);
      }

      .task-name {
        flex: 0 1 auto;
        min-width: 0;
        max-width: min(14rem, 45%);
        ${truncateDeclarations}
        font-weight: var(--font-weight-medium);
      }

      .task-latest {
        flex: 1 1 8rem;
        min-width: 0;
        ${truncateDeclarations}
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .task-elapsed {
        flex-shrink: 0;
        margin-inline-start: auto;
        font-size: var(--font-size-xs);
        font-variant-numeric: tabular-nums;
        color: var(--color-text-secondary);
      }
      .task-elapsed.is-approval {
        color: var(--color-warning);
      }

      .task-chevron {
        flex-shrink: 0;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }
      :dir(rtl) .task-chevron {
        transform: scaleX(-1);
      }
    `,
  ];

  /** The dispatching run: the children it dispatched are the rows
   *  (`dispatchedChildren`: a script's calls live in its stage). */
  @property({ attribute: false }) run: RunView | null = null;
  @property({ attribute: false }) view: SessionView | null = null;
  /** The card's open state lives here (`groups`, key `dispatch`). */
  @property({ attribute: false }) surface: Surface | null = null;

  /** The clock a running row's elapsed time ticks on. */
  private readonly _ticker = new TickerController(this, 1000);

  private childrenOf(run: RunView): RunView[] {
    return this.view ? dispatchedChildren(run, this.view) : [];
  }

  /** Every run the card lists, nested ones included: its running badge,
   *  its counts and its since time read this one set, so a listed child
   *  that finishes while a listed grandchild runs leaves the badge lit and
   *  the time standing, and a script's children (listed by its stage) count
   *  nowhere here. */
  private listedUnder(runs: readonly RunView[]): RunView[] {
    return runs.flatMap((child) => [
      child,
      ...this.listedUnder(this.childrenOf(child)),
    ]);
  }

  /** The card's counts over the tree it lists. */
  private listedRollup(runs: readonly RunView[]): RunView['rollup'] {
    return rollupOf(runs, (child) => this.listedRollup(this.childrenOf(child)));
  }

  override render(): TemplateResult | typeof nothing {
    const run = this.run;
    if (!run) return nothing;
    const children = this.childrenOf(run);
    if (children.length === 0) return nothing;

    // Over the children this card lists, not every descendant the run's
    // own `rollup` counts: a script's calls are its stage's.
    const listed = this.listedUnder(children);
    const rollup = this.listedRollup(children);
    // A listed run's `approval` bubbles up from anything under it, its
    // script's calls included: the row to open is the listed one.
    const approval = children.some((child) => child.approval !== 'none');
    // When the fan-out began: the earliest descendant still running, over
    // the set `rollup.running` counts. The session view clears `runStartedAt` on a
    // terminal status, so a finished fan-out has no start to name and the
    // line drops.
    const starts = listed.flatMap(
      (descendant) => descendant.runStartedAt ?? [],
    );
    const since = starts.length > 0 ? Math.min(...starts) : null;
    const counts = nestedCountsLabel(rollup.kinds);
    const summary = html`${waIcon('diagram-project')}
    ${dispatchSummary(counts)}${
      rollup.running > 0
        ? html`<wa-badge variant="success" pill
            >${rollup.running} running</wa-badge
          >`
        : nothing
    }${
      approval
        ? html`<wa-badge variant="warning" pill
            >${waIcon('triangle-exclamation')}</wa-badge
          >`
        : nothing
    }${
      since === null
        ? nothing
        : html`<span class="dispatch-since"
            >since ${getTimeFormatter().format(new Date(since))}</span
          >`
    }`;
    const open =
      this.surface?.runs.get(run.id)?.disclosures.get(DISPATCH_GROUP_KEY) !==
      false;

    return html`
      <wa-details
        class="dispatch"
        ?open=${open}
        @wa-show=${this.handleToggle}
        @wa-hide=${this.handleToggle}
      >
        <span slot="summary" class="dispatch-summary">${summary}</span>
        <div class="task-list" role="list">
          ${this.renderChildren(children, 0)}
        </div>
      </wa-details>
    `;
  }

  private handleToggle(event: Event): void {
    dispatchDisclosureToggle(
      this,
      event,
      this.run?.id ?? null,
      DISPATCH_GROUP_KEY,
    );
  }

  private renderChildren(
    children: readonly RunView[],
    depth: number,
  ): TemplateResult {
    return html`${repeat(
      children,
      (child) => child.id,
      (child) =>
        html`${this.renderChildRow(child, depth)}${this.renderChildren(
          this.childrenOf(child),
          depth + 1,
        )}`,
    )}`;
  }

  private renderChildRow(child: RunView, depth: number): TemplateResult {
    const status = runStatus(child);
    const latest = child.latestLine ?? child.description ?? '';
    const label = `Open ${child.label}: ${status.word}`;
    return html`
      <button
        type="button"
        role="listitem"
        class=${classMap({
          'task-row': true,
          'focus-ring-inset': true,
          [`tone-${status.tone}`]: true,
        })}
        style=${styleMap({ '--tree-depth': String(depth) })}
        aria-label=${label}
        @click=${() => this.navigateToRun(child.id)}
      >
        ${waIcon(status.glyph, { className: 'task-icon' })}
        <span class="task-name">${child.label}</span>
        ${latest ? html`<span class="task-latest">${latest}</span>` : nothing}
        ${renderClock(child, child.approval === 'own', this._ticker.now)}
        ${waIcon('chevron-right', { className: 'task-chevron' })}
      </button>
    `;
  }

  private navigateToRun(runId: RunId): void {
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'select', runId }));
  }
}

/**
 * The row's clock: "approval" while the child waits on the user, the live
 * elapsed while it runs (the host ticks), else when it was last active.
 */
function renderClock(
  child: RunView,
  pendingApproval: boolean,
  nowMs: number,
): TemplateResult {
  if (pendingApproval) {
    return html`<span class="task-elapsed is-approval">approval</span>`;
  }
  if (child.runStartedAt !== null) {
    return html`<span class="task-elapsed"
      >${formatCompactDuration(nowMs - child.runStartedAt)}</span
    >`;
  }
  return html`<wa-relative-time
    class="task-elapsed"
    .date=${new Date(child.lastTimestamp)}
    format="narrow"
    sync
  ></wa-relative-time>`;
}

declare global {
  interface HTMLElementTagNameMap {
    'background-tasks-panel': BackgroundTasksPanel;
  }
}
