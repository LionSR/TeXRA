// One run row of the run list: its title, status glyph, rollup and the
// row actions (expand, and, where the list is `removable`, delete). An
// interrupted row says so; its one Resume is on the task's ended line, which
// the row opens. `run-tabs` lays the rows out.
import { String as Str } from 'effect';
import {
  getBasename,
  formatResultCount,
  joinFacts,
  runNoun,
} from '@texra-ai/harness/schemas';
import {
  LitElement,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports
import { SessionUiEvents } from '@ui/progress/uiEvents';
import {
  runNoticeText,
  runStatus,
  runStatusLabel,
  runStatusLook,
  statusGlyph,
  type RunTone,
} from '@ui/copy/runStatus';
import { designTokens } from '@ui/styles';
import {
  buttonStyles,
  focusRingStyles,
  formControlStyles,
} from '@ui/styles/controlStyles';
import { renderIconActionButtonParts } from '@ui/wa/actionButtons';
import { actionMenu, type ActionMenuItem } from '@ui/wa/actionMenu';
import type { WaSelectEvent } from '@awesome.me/webawesome/dist/events/events.js';
import { inlineRenameField } from '@ui/wa/inlineRename';
import { AGENT_DECORATORS, type RunDecorator } from '@ui/wa/icons';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import './WorktreeChip';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import {
  NESTED_AGENT,
  nestedCountsLabel,
  nestedRollupLabel,
  TASK_ACTIONS,
} from '@ui/copy/nestedRuns';
import { formatRelativeTime } from '@ui/copy/format';
import { TickerController } from '@ui/litControllers/TickerController';
import { runTabStyles } from './RunTab.styles';
import type { RunView } from '@texra-ai/harness/schemas';

/** How the row reads: a request anywhere under the run (its own, or a
 *  descendant's) waits on the user, which the row says in the status
 *  table's word for that state; otherwise as the run's status reads. */
function rowStatus(run: RunView): {
  readonly word: string;
  readonly tone: RunTone;
  readonly glyph: ReturnType<typeof statusGlyph>;
  readonly waiting: boolean;
  readonly shown: boolean;
} {
  const status = runStatus(run);
  if (run.approval === 'none')
    return { ...status, waiting: false, shown: status.tone !== 'neutral' };
  return {
    word: runStatusLabel('waitingOnUser'),
    // The row keeps its run's own tone; only its word and glyph say a
    // request waits under it.
    tone: status.tone,
    glyph: statusGlyph(runStatusLook('waitingOnUser')),
    waiting: true,
    shown: true,
  };
}

function buildTooltip(run: RunView, nowMs: number): string {
  const modelDisplay = run.identity.kind === 'agent' ? run.modelLabel : null;
  const worktree = run.worktree;
  const worktreeDisplay = worktree
    ? `Worktree: ${getBasename(worktree.workingDirectory)}`
    : undefined;
  const mainLine = joinFacts([
    run.label,
    `Status: ${rowStatus(run).word}`,
    run.rollup.total > 0 && nestedRollupLabel(run.rollup),
    modelDisplay && `Model: ${modelDisplay}`,
    worktreeDisplay,
  ]);
  const lastSeen = formatRelativeTime(run.lastTimestamp, nowMs);
  // No raw id: two parallel agents differ by title, model and time, and
  // the id is for bug reports ("Copy diagnostics").
  return [
    mainLine,
    run.description,
    runNoticeText(run),
    lastSeen && `Last activity ${lastSeen}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function runDecorator(run: RunView) {
  const kind = run.identity.kind;
  return kind === 'agent'
    ? AGENT_DECORATORS.agentRuns[run.program ? 'task' : 'chat']
    : AGENT_DECORATORS.streamKinds[kind];
}

/**
 * One run row. Re-renders when its own `.run` ref or a flag changes (the
 * session view replaces a run's value only when that run changes, so rows of
 * untouched runs skip rendering on every update), and on its clock's tick,
 * which keeps the tooltip's "Last activity" age current.
 */
@customElement('run-tab')
export class RunTab extends LitElement {
  static override styles = [
    designTokens,
    buttonStyles,
    focusRingStyles,
    formControlStyles,
    runTabStyles,
  ];

  @property({ attribute: false }) run!: RunView;
  private readonly ticker = new TickerController(this, 30_000);
  @property({ type: Boolean }) active = false;
  /** Children are shown beneath this row. */
  @property({ type: Boolean, reflect: true }) expanded = false;
  /** This row has a child list to expand. */
  @property({ type: Boolean }) expandable = false;
  /** Finished since the user last had it on screen. */
  @property({ type: Boolean }) unseen = false;
  /** Messages queued on the run that it has not read yet. */
  @property({ type: Number }) unread = 0;
  /** The row offers Delete (the desktop rail); set only on a run whose
   *  `actions` hold `delete`. */
  @property({ type: Boolean }) removable = false;
  @state() private renaming = false;

  private startRename(): void {
    if (!this.run.actions.includes('rename')) return;
    this.renaming = true;
  }

  /** Closing the field hands focus back to the row it replaced. */
  private closeRename(): void {
    this.renaming = false;
    void this.updateComplete.then(() => this.focus());
  }

  private decorator: RunDecorator = AGENT_DECORATORS.agentRuns.chat;

  /** Focus lands on the row's select button: `run-tabs` hands focus to a
   *  neighbour after deleting the focused row. */
  override focus(options?: FocusOptions): void {
    this.renderRoot
      .querySelector<HTMLElement>('#run-tab-select-button')
      ?.focus(options);
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('run')) this.decorator = runDecorator(this.run);
  }

  override render(): TemplateResult {
    const run = this.run;
    const notice = runNoticeText(run);
    const status = rowStatus(run);
    const runTitle = run.title;
    const tooltip = buildTooltip(run, this.ticker.now);
    const noun = runNoun(run);
    const childCountLabel = nestedCountsLabel(run.rollup.kinds);
    const childToggleLabel = this.expanded
      ? NESTED_AGENT.collapseAction
      : childCountLabel;
    const metaAgentName =
      run.identity.kind === 'agent' && run.description ? run.label : undefined;
    // The rollup is the row's own fact: the rail carries it with no
    // disclosure at all, and a tree row hides it while open.
    const showRollup = run.rollup.total > 0 && !this.expanded;
    const menuItems: ActionMenuItem[] = [];
    if (run.actions.includes('rename')) {
      menuItems.push({
        icon: 'pencil',
        label: TASK_ACTIONS.rename,
        focusesOwn: true,
        activate: () => this.startRename(),
      });
    }
    if (this.removable) {
      menuItems.push({
        icon: 'trash',
        label: TASK_ACTIONS.delete(run),
        variant: 'danger',
        activate: () =>
          this.dispatchEvent(
            new CustomEvent('run-row-delete', {
              bubbles: true,
              composed: true,
            }),
          ),
      });
    }
    const menu = actionMenu(menuItems);
    const actions = renderIconActionButtonParts({
      id: 'run-tab-actions',
      icon: 'ellipsis',
      slot: 'trigger',
      label: `Actions for ${noun} ${runTitle}`,
      tooltip: `${Str.capitalize(noun)} actions`,
    });

    return html`
      <div
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === 'F2' && !this.renaming) {
            event.preventDefault();
            this.startRename();
          }
        }}
        class=${classMap({
          'tab-container': true,
          'is-active': this.active,
          [`tone-${status.tone}`]: true,
          'has-pending-approval': status.waiting,
          'is-unseen': this.unseen,
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
                  >${waIcon('chevron-right', { className: 'disclosure-chevron' })}</wa-button
                ><wa-tooltip for="run-tab-expand-button"
                  >${childToggleLabel}</wa-tooltip
                >`
            : nothing
        }
        <div class="tab-select-tooltip-anchor">
          ${
            this.renaming
              ? inlineRenameField({
                  value: runTitle,
                  label: 'Task title',
                  className: 'tab-rename',
                  onRename: (title) =>
                    this.dispatchEvent(
                      SessionUiEvents.runtime({
                        kind: 'run.rename',
                        runId: run.id,
                        title,
                      }),
                    ),
                  onClose: () => this.closeRename(),
                })
              : nothing
          }
          <button
            id="run-tab-select-button"
            class="tab focus-ring-inset"
            data-run=${run.id}
            data-action="select"
            aria-label=${tooltip}
            ?hidden=${this.renaming}
            @dblclick=${() => this.startRename()}
          >
            <div class="tab-header">
              ${
                this.unseen
                  ? html`<span
                      class="status-indicator tab-unseen"
                      role="img"
                      aria-label="Finished since you last looked"
                    ></span>`
                  : nothing
              }
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
                  ? html`<span class="tab-rollup"
                      >${nestedRollupLabel(run.rollup)}</span
                    >`
                  : nothing
              }
              ${
                this.unread > 0
                  ? html`<span class="tab-rollup"
                      >${formatResultCount(this.unread, 'unread message')}</span
                    >`
                  : nothing
              }
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
              <wa-relative-time
                class="last-active"
                .date=${new Date(run.lastTimestamp)}
                format="narrow"
                sync
              ></wa-relative-time>
              <span class="model"
                >${
                  run.identity.kind === 'agent' ? run.modelLabel : nothing
                }</span
              >
              ${waIcon(this.decorator.icon, { id: 'run-tab-kind', className: 'run-kind' })}
            </div>
            ${notice ? html`<div class="tab-detail">${notice}</div>` : nothing}
          </button>
          ${status.shown ? html`<wa-tooltip for="run-tab-status">${status.word}</wa-tooltip>` : nothing}
        </div>
        ${
          status.shown
            ? html`<span
                id="run-tab-status"
                class="tab-status"
                role="img"
                aria-label=${status.word}
              >
                ${waIcon(status.glyph, { className: 'tab-status-icon' })}
                ${status.waiting ? html`<span class="tab-status-label">${status.word}</span>` : nothing}
              </span>`
            : nothing
        }
        <wa-tooltip for="run-tab-kind">${this.decorator.label}</wa-tooltip>
        ${
          menuItems.length > 0
            ? html`<wa-dropdown
                  class="tab-actions"
                  placement="bottom-end"
                  @wa-select=${(event: WaSelectEvent) => {
                    event.stopPropagation();
                    menu.onSelect(event);
                  }}
                >
                  ${actions.button} ${menu.items}
                </wa-dropdown>
                ${actions.tooltip}`
            : nothing
        }
      </div>
    `;
  }
}
