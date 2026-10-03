import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

import {
  APPROVAL_BYPASS_KINDS,
  type ApprovalBypassKind,
} from '@shared/approvalBypassKind';
import type { RunId } from '@shared/schemas';
import { goalStateOf, type GoalState } from '@shared/plugins/goal';
import type { SessionView, RunView } from '@shared/session/sessionView';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { CopyButtonController } from '@shared/litControllers/CopyButtonController';
import type { TeXRAIconName } from '@shared/iconNames';
import { TASK_ACTIONS } from '@ui/copy/nestedRuns';
import { formatTaskDiagnostics } from '@ui/copy/taskDiagnostics';
import { designTokens, commonViewStyles } from '@ui/styles';
import { statusIndicatorStyles } from '@ui/styles/statusIndicatorStyles';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import '@progressView/frontend/components/ToolTimer';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';

import {
  ELEMENT_IDS,
  NEUTRAL_RUN_ACTIONS,
  RUN_MENU_ACTIONS,
  type RunMenuAction,
} from '../constants';
import { progressBadgeLabel } from '../formatters/progressBadgeFormatter';
import {
  autoApproveStyles,
  renderAutoApproveMenu,
  renderAutoApproveRow,
  WideHeaderController,
} from './autoApproveSwitches';
import type WaDropdownItem from '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import type { WaSelectEvent } from '@awesome.me/webawesome/dist/events/events.js';

/** A window-level item the shell appends to the run's menu: pop out,
 *  LaTeXDiffs, figures. */
export interface HeaderMenuItem {
  readonly value: string;
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly activate: () => void;
}

/** The menu value of the delete item. */
const DELETE_SESSION = 'deleteSession';

/** The status dot's hue per tone (G4: the fold spells the tone). */
const TONE_INDICATOR_CLASS: Record<RunView['tone'], string> = {
  running: 'is-running',
  success: 'is-completed',
  danger: 'is-failed',
  warning: 'is-starting',
  neutral: 'is-ready',
};

/**
 * `<run-header>`: the one header row of a selected run (PRD 12.1). The
 * shell slots its own controls around it (the Sessions button at `start`,
 * New task at `end`), so a run never shows two rows of chrome: path and
 * title, status, time, an active run grant, Stop, and one menu holding the
 * run's actions, the shell's window items, and last, Delete task.
 */
@customElement('run-header')
export class RunHeader extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    statusIndicatorStyles,
    css`
      :host {
        display: block;
        box-sizing: border-box;
        min-width: 0;
        max-width: 100%;
        container-type: inline-size;
      }

      .log-header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
        min-height: var(--height-header);
        box-sizing: border-box;
        min-width: 0;
        max-width: 100%;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      #activeRunName {
        flex: 1;
        min-width: 6ch;
        margin: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--wa-color-text-normal);
        font-size: var(--font-size);
        font-weight: var(--font-weight-semibold);
        line-height: 1.2;
        letter-spacing: -0.012em;
      }

      .status-label,
      tool-timer {
        flex: 0 0 auto;
        white-space: nowrap;
      }

      .status-indicator {
        flex: 0 0 auto;
        width: 7px;
        height: 7px;
        margin: 0 var(--wa-space-3xs);
      }

      .stop-button {
        color: var(--color-error);
      }

      .goal-chip::part(base) {
        gap: var(--wa-space-3xs);
        padding: 0 var(--wa-space-2xs);
        font-weight: var(--font-weight-medium);
      }

      .goal-chip wa-icon {
        font-size: var(--font-size-xs);
      }

      .goal-chip {
        flex-shrink: 0;
      }

      .menu-status {
        padding: var(--wa-space-2xs) var(--wa-space-s) var(--wa-space-3xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        white-space: nowrap;
      }

      /* The ancestors path, root first, capped at 40% of the row; laid out
         in reverse DOM order so an overflow clips the root end and the
         nearest ancestor survives. */
      .ancestors {
        display: flex;
        flex-direction: row-reverse;
        justify-content: flex-start;
        align-items: center;
        gap: var(--wa-space-3xs);
        flex: 0 1 auto;
        max-width: 40%;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
      }
      .ancestor {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        flex: 0 1 auto;
        min-width: 0;
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        background: var(--wa-color-neutral-fill-quiet);
        border: none;
        border-radius: var(--border-radius-small);
        font: inherit;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        cursor: pointer;
      }
      .ancestor-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .ancestor:hover {
        color: var(--color-text-link);
      }
      .ancestor:focus-visible {
        border-radius: var(--border-radius-small);
      }
      .ancestor-separator {
        flex: 0 0 auto;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }
      :dir(rtl) .ancestor-separator {
        transform: scaleX(-1);
      }
      wa-tag.progress-badge {
        font-variant-numeric: tabular-nums;
      }

      /* A narrow row keeps the title: the status word and the pass chip
         move into the menu's status line. */
      @container (max-width: 640px) {
        .status-label,
        wa-tag.progress-badge {
          display: none;
        }
      }
    `,
    autoApproveStyles,
  ];

  @property({ attribute: false }) run: RunView | null = null;
  /** For the per-run policy snapshot behind the auto-approve switches. */
  @property({ attribute: false }) view: SessionView | null = null;
  /** The shell's window items, after the run's actions in its menu. */
  @property({ attribute: false }) menuItems: readonly HeaderMenuItem[] = [];
  /** A workflow agent's planned pass count, from the agent catalog. */
  @property({ attribute: false }) plannedPasses: number | undefined;

  private readonly width = new WideHeaderController(this);

  private readonly copyDiagnostics = new CopyButtonController(this, {
    successTitle: 'Copied!',
  });

  /** Send what a run action names (see `RunMenuAction.arm`). */
  private dispatchAction(action: RunMenuAction, run: RunView): void {
    const runId = run.id;
    if (action.arm === 'copyDiagnostics') {
      void this.copyDiagnostics.copy(formatTaskDiagnostics(run));
    } else if (action.arm === 'run.compact') {
      this.dispatchEvent(
        SessionUiEvents.runtime({ kind: 'run.compact', runId }),
      );
    } else {
      this.dispatchEvent(SessionUiEvents.host({ kind: action.arm, runId }));
    }
  }

  /** Whether a run grant is on, per the run's policy snapshot. */
  private grantActive(run: RunView, kind: ApprovalBypassKind): boolean {
    return this.view?.policy.get(run.id)?.bypasses[kind] === true;
  }

  /** Set or clear one run grant, as an approval card's grant does. */
  private setGrant(
    run: RunView,
    bypass: ApprovalBypassKind,
    enabled: boolean,
  ): void {
    this.dispatchEvent(
      SessionUiEvents.runtime({
        kind: 'policy.set',
        change: { field: 'bypass', runId: run.id, bypass, enabled },
      }),
    );
  }

  override render(): TemplateResult | typeof nothing {
    const run = this.run;
    if (!run) return nothing;
    const statusLabel = run.statusLabel;
    const goal = goalStateOf(run);
    // The header offers exactly what the fold's `actions` licenses.
    const canStop = run.actions.includes('stop');
    const canGrant = run.actions.includes('grant');
    const passLabel = progressBadgeLabel(run.position, this.plannedPasses);

    return html`
      <div class="log-header">
        <slot name="start"></slot>
        ${this.renderAncestors(run)}
        <h1 id=${ELEMENT_IDS.ACTIVE_RUN_NAME} data-run=${run.id}>
          ${run.description || run.label}
        </h1>
        <wa-tooltip for=${ELEMENT_IDS.ACTIVE_RUN_NAME}>${run.label}</wa-tooltip>
        <span
          id=${ELEMENT_IDS.STATUS_INDICATOR}
          role="img"
          aria-label=${statusLabel}
          class=${classMap({
            'status-indicator': true,
            [TONE_INDICATOR_CLASS[run.tone]]: true,
          })}
        ></span>
        <wa-tooltip for=${ELEMENT_IDS.STATUS_INDICATOR}>
          ${run.statusDetail ?? statusLabel}
        </wa-tooltip>
        <span class="status-label" aria-hidden="true">${statusLabel}</span>
        ${this.renderRunElapsed(run)} ${this.renderGoalChip(goal)}
        ${this.renderPassBadge(passLabel)}
        ${
          canGrant
            ? renderAutoApproveRow(
                this.width.wide,
                (kind) => this.grantActive(run, kind),
                (kind, on) => this.setGrant(run, kind, on),
              )
            : nothing
        }
        ${
          canStop
            ? renderIconActionButton({
                id: ELEMENT_IDS.STOP_STREAM_BTN,
                icon: 'circle-stop',
                label: 'Stop',
                tooltip: 'Stop',
                className: 'stop-button',
                onClick: () =>
                  this.dispatchEvent(
                    SessionUiEvents.runtime({
                      kind: 'run.stop',
                      runId: run.id,
                      reason: 'user',
                    }),
                  ),
              })
            : nothing
        }
        <slot name="end"></slot>
        ${this.renderMenu(run, statusLabel, passLabel, canGrant)}
      </div>
    `;
  }

  private renderMenu(
    run: RunView,
    statusLabel: string,
    passLabel: string | undefined,
    canGrant: boolean,
  ): TemplateResult {
    // An agent run's menu lists its category's actions, a process's or a
    // workflow container's the neutral ones, each shown only while the
    // run's `actions` holds it. Edit as new task lives in the conversation's
    // ended line.
    const actions = (
      run.identity.kind === 'agent'
        ? RUN_MENU_ACTIONS[run.category]
        : NEUTRAL_RUN_ACTIONS
    ).filter((action) => run.actions.includes(action.action));
    const copied = this.copyDiagnostics.state.copied;
    const canDelete = run.actions.includes('delete');
    return html`
      <wa-dropdown
        placement="bottom-end"
        @wa-select=${(event: WaSelectEvent) => {
          const { item } = event.detail;
          if (item.localName !== 'wa-dropdown-item') return;
          const { value, checked, dataset } = item as WaDropdownItem;
          const bypass = APPROVAL_BYPASS_KINDS.find(
            (kind) => kind === dataset.bypass,
          );
          if (bypass) {
            // A switch keeps the menu open, so a second one is one click away.
            event.preventDefault();
            this.setGrant(run, bypass, checked);
            return;
          }
          if (value === DELETE_SESSION) {
            this.dispatchEvent(
              SessionUiEvents.runtime({ kind: 'run.delete', runId: run.id }),
            );
            return;
          }
          const action = actions.find((candidate) => candidate.id === value);
          if (action) this.dispatchAction(action, run);
          else
            this.menuItems.find((entry) => entry.value === value)?.activate();
        }}
      >
        <wa-button
          slot="trigger"
          id=${ELEMENT_IDS.HEADER_MORE_BTN}
          class="action-icon-button"
          appearance="plain"
          variant="neutral"
          size="s"
          type="button"
          aria-label="More"
          >${waIcon('ellipsis')}</wa-button
        >
        <div class="menu-status">
          ${statusLabel}${passLabel ? ` · ${passLabel}` : ''}
        </div>
        ${
          canGrant && !this.width.wide
            ? renderAutoApproveMenu((kind) => this.grantActive(run, kind))
            : nothing
        }
        ${repeat(
          actions,
          (action) => action.id,
          (action) => {
            const isCopy = action.arm === 'copyDiagnostics';
            return html`<wa-dropdown-item value=${action.id}
              >${waIcon(isCopy && copied ? 'check' : action.icon, {
                slot: 'icon',
              })}${action.label}</wa-dropdown-item
            >`;
          },
        )}
        ${repeat(
          this.menuItems,
          (item) => item.value,
          (item) =>
            html`<wa-dropdown-item value=${item.value}
              >${waIcon(item.icon, { slot: 'icon' })}${item.label}</wa-dropdown-item
            >`,
        )}
        ${
          canDelete
            ? html`<wa-divider></wa-divider
                ><wa-dropdown-item value=${DELETE_SESSION} variant="danger"
                  >${waIcon('trash', { slot: 'icon' })}${TASK_ACTIONS.delete}</wa-dropdown-item
                >`
            : nothing
        }
      </wa-dropdown>
      <wa-tooltip for=${ELEMENT_IDS.HEADER_MORE_BTN}>More</wa-tooltip>
    `;
  }

  private renderGoalChip(goal: GoalState): TemplateResult | typeof nothing {
    if (!goal.active) return nothing;
    const isPaused = goal.status === 'paused';
    const label = isPaused ? 'Goal paused' : 'Goal';
    const tooltip = goal.objective ? `${label}: ${goal.objective}` : label;
    return html`<wa-badge
        id=${ELEMENT_IDS.GOAL_CHIP}
        class="goal-chip"
        variant=${isPaused ? 'warning' : 'brand'}
        appearance="filled"
        aria-label=${tooltip}
      >
        ${waIcon('compass')} ${label}
      </wa-badge>
      <wa-tooltip for=${ELEMENT_IDS.GOAL_CHIP}>${tooltip}</wa-tooltip>`;
  }

  private renderRunElapsed(run: RunView): TemplateResult | typeof nothing {
    if (run.runStartedAt === null || run.group === 'recent') {
      return nothing;
    }
    return html`<tool-timer .startTime=${run.runStartedAt}></tool-timer>`;
  }

  private renderPassBadge(
    label: string | undefined,
  ): TemplateResult | typeof nothing {
    if (label === undefined) return nothing;
    return html`<wa-tag
      id=${ELEMENT_IDS.PROGRESS_BADGE}
      class="progress-badge"
      variant="neutral"
      size="s"
      ><bdi dir="auto">${label}</bdi></wa-tag
    >`;
  }

  /** The full ancestors path, root first, each segment a link to that
   *  run. Laid out nearest-first in the DOM (see the styles). */
  private renderAncestors(run: RunView): TemplateResult | typeof nothing {
    if (run.ancestors.length === 0) return nothing;
    const nearestFirst = run.ancestors.toReversed();
    return html`
      <nav class="ancestors" aria-label=${TASK_ACTIONS.ancestors}>
        ${repeat(
          nearestFirst,
          (ancestor) => ancestor.id,
          (ancestor, index) => html`
            <span class="ancestor-separator" aria-hidden="true"
              >${waIcon('chevron-right')}</span
            >
            <button
              type="button"
              class="ancestor"
              id=${`ancestor-${index}`}
              aria-label=${`Go to ${ancestor.label}`}
              @click=${() => this.navigateTo(ancestor.id)}
            >
              <span class="ancestor-label">${ancestor.label}</span>
            </button>
            <wa-tooltip for=${`ancestor-${index}`}
              >Go to ${ancestor.label}</wa-tooltip
            >
          `,
        )}
      </nav>
    `;
  }

  private navigateTo(runId: RunId): void {
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'select', runId }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'run-header': RunHeader;
  }
}
