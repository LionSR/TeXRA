// One run row of the run list: its title, status glyph, rollup and the
// row actions (expand, resume, and, where the list offers a `menu`, the run
// menu on `⋯` and right-click). `run-tabs` lays the rows out.
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
import { CopyButtonController } from '@shared/litControllers/CopyButtonController';
import type { RunView } from '@shared/session/sessionView';
import { designTokens } from '@ui/styles';
import { focusRingStyles } from '@ui/styles/controlStyles';
import { AGENT_DECORATORS, getAgentCategoryDecorator } from '@ui/wa/icons';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import './WorktreeChip';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { type TeXRAIconName } from '@ui/wa/iconNames';
import { BACKGROUND_TASK } from '@ui/copy/nestedRuns';
import { getBasename } from '@utils/core';
import { formatRelativeTime, formatResultCount } from '@utils/text/stringUtils';
import { runTabStyles } from './RunTab.styles';
import {
  deleteSessionConfirmStyles,
  renderDeleteSessionConfirm,
} from './deleteSessionConfirm';
import { renderRunMenuItems, selectRunMenuItem } from './runMenu';
import type WaDropdown from '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import type WaDropdownItem from '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import type { WaSelectEvent } from '@awesome.me/webawesome/dist/events/events.js';

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
    `Status: ${run.approval === 'none' ? run.statusLabel : 'Needs approval'}`,
    run.rollup.total > 0 && rollupLabel(run),
    modelDisplay && `Model: ${modelDisplay}`,
    worktreeDisplay,
  ]
    .filter(Boolean)
    .join(' · ');
  const lastSeen = run.lastTimestamp
    ? formatRelativeTime(run.lastTimestamp)
    : '';
  // The opaque id stays in the accessible name: it is what tells two
  // parallel runs of the same agent apart.
  return [
    mainLine,
    run.description,
    run.statusDetail,
    run.id,
    lastSeen && `Last activity ${lastSeen}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** A collapsed parent's descendants in words: "2 background tasks · 1 running". */
function rollupLabel(run: RunView): string {
  const total = formatResultCount(run.rollup.total, BACKGROUND_TASK.countNoun);
  return run.rollup.running > 0
    ? `${total} · ${run.rollup.running} running`
    : total;
}

function runDecorator(run: RunView) {
  const kind = run.identity.kind;
  return kind === 'multiAgentWorkflow' || kind === 'process'
    ? AGENT_DECORATORS.streamKinds[kind]
    : getAgentCategoryDecorator(run.category);
}

/**
 * One run row. Re-renders only when its own `.run` ref or a flag
 * changes; the fold replaces a run's value only when that run changes,
 * so rows of untouched runs skip rendering on every update.
 */
@customElement('run-tab')
export class RunTab extends LitElement {
  static override styles = [
    designTokens,
    focusRingStyles,
    runTabStyles,
    deleteSessionConfirmStyles,
  ];

  @property({ attribute: false }) run!: RunView;
  @property({ type: Boolean }) active = false;
  /** Children are shown beneath this row. */
  @property({ type: Boolean, reflect: true }) expanded = false;
  /** This row has a child list to expand. */
  @property({ type: Boolean }) expandable = false;
  /** Finished since the user last had it on screen. */
  @property({ type: Boolean }) unseen = false;
  /** Messages queued on the run that it has not read yet. */
  @property({ type: Number }) unread = 0;
  /** The row offers the run menu, the header's own (the desktop rail). */
  @property({ type: Boolean }) menu = false;
  /** The menu's permanent delete was chosen: its question is open. */
  @state() private confirmingDelete = false;

  private decorator = getAgentCategoryDecorator('toolUse');

  private readonly copyRunContext = new CopyButtonController(this);

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('run')) this.decorator = runDecorator(this.run);
    // A run that stopped taking `delete` (it resumed) drops the question.
    if (!this.menu || !this.run.actions.includes('delete'))
      this.confirmingDelete = false;
  }

  protected override updated(changed: PropertyValues): void {
    // Opening the confirmation moves focus to its safe choice; closing it
    // took the focused button away, so focus returns to the row. The first
    // render moves nothing, and neither does a close while focus is
    // elsewhere.
    if (changed.get('confirmingDelete') === undefined) return;
    if (this.confirmingDelete) {
      this.renderRoot
        .querySelector<HTMLElement>('.delete-confirm-cancel')
        ?.focus();
    } else if (document.activeElement === document.body) {
      this.renderRoot.querySelector<HTMLElement>('.tab')?.focus();
    }
  }

  private readonly dismissDelete = (): void => {
    this.confirmingDelete = false;
  };

  /** Right-click opens the same menu as the row's `⋯`. */
  private readonly openMenu = (event: MouseEvent): void => {
    if (!this.menu) return;
    event.preventDefault();
    const dropdown = this.renderRoot.querySelector<WaDropdown>('.tab-menu');
    if (dropdown) dropdown.open = true;
  };

  private renderMenu(run: RunView, runTitle: string): TemplateResult {
    return html`<wa-dropdown
        class="tab-menu"
        placement="bottom-end"
        @wa-select=${(event: WaSelectEvent) => {
          const { value } = event.detail.item as WaDropdownItem;
          const chosen = selectRunMenuItem(
            this,
            run,
            value,
            this.copyRunContext,
          );
          if (chosen === 'delete') this.confirmingDelete = true;
        }}
      >
        <wa-button
          slot="trigger"
          id="run-tab-menu-button"
          class="tab-more"
          appearance="plain"
          variant="neutral"
          size="s"
          type="button"
          aria-label=${`More actions for ${runTitle}`}
          >${waIcon('ellipsis')}</wa-button
        >
        ${renderRunMenuItems(run, this.copyRunContext)}
      </wa-dropdown>
      <wa-tooltip for="run-tab-menu-button">More</wa-tooltip>`;
  }

  override render(): TemplateResult {
    const run = this.run;
    const pendingApproval = run.approval !== 'none';
    const statusGlyph = pendingApproval
      ? 'triangle-exclamation'
      : TONE_ICONS[run.tone];
    const accessibleStatusLabel = pendingApproval
      ? 'Needs approval'
      : run.statusLabel;
    const runTitle = run.description || run.label;
    const tooltip = buildTooltip(run);
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
          'is-unseen': this.unseen,
        })}
        @contextmenu=${this.openMenu}
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
            aria-label=${tooltip}
            title=${tooltip}
          >
            <div class="tab-header">
              ${
                this.unseen
                  ? html`<span
                      class="tab-unseen"
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
                  ? html`<span class="tab-rollup">${rollupLabel(run)}</span>`
                  : nothing
              }
              ${
                this.unread > 0
                  ? html`<span class="tab-rollup"
                      >${formatResultCount(this.unread, 'unread message')}</span
                    >`
                  : nothing
              }
              <span
                id="run-tab-status"
                class="tab-status"
                role="img"
                aria-label=${accessibleStatusLabel}
              >
                ${waIcon(statusGlyph, { className: 'tab-status-icon' })}${
                  pendingApproval
                    ? html`<span class="tab-status-label">Needs approval</span>`
                    : nothing
                }
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
        >
        ${
          run.group === 'interrupted' && run.actions.includes('resume')
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
        ${this.menu ? this.renderMenu(run, runTitle) : nothing}
      </div>
      ${
        this.confirmingDelete
          ? renderDeleteSessionConfirm(run, this.dismissDelete)
          : nothing
      }
    `;
  }
}
