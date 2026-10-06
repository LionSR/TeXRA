import '@awesome.me/webawesome/dist/components/tag/tag.js';
import {
  LitElement,
  html,
  css,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

import { type ApprovalBypassKind } from '@shared/approvalBypassKind';
import { resolveBypass } from '@shared/approvalBypassKind';
import { goalStateOf, type GoalState } from '@shared/plugins/goal';
import type { SessionView, RunView } from '@shared/session/sessionView';
import type { TeXRAIconName } from '@shared/iconNames';
import { SessionUiEvents } from '@texra/shared/session/uiEvents';
import { CopyButtonController } from '@texra/shared/litControllers/CopyButtonController';
import { TASK_ACTIONS } from '@ui/copy/nestedRuns';
import { formatTaskDiagnostics } from '@ui/copy/taskDiagnostics';
import { designTokens, commonViewStyles } from '@ui/styles';
import { statusIndicatorStyles } from '@ui/styles/statusIndicatorStyles';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import { selectedItemValue } from '@ui/wa/selectTemplates';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import '@progressView/frontend/components/ToolTimer';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';

import {
  ELEMENT_IDS,
  NEUTRAL_RUN_ACTIONS,
  runMenuActions,
  type RunMenuAction,
} from '../constants';
import { progressBadgeLabel } from '../formatters/progressBadgeFormatter';
import { renderRunGrantChips, runGrantStyles } from './runGrantChips';
import type { RunId } from '@texra-ai/harness/schemas';
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
/** The menu value of the rename item, which turns the title into a field. */
const RENAME_TASK = 'renameTask';
/** The menu values of Fork and Hand off, and the prefix of a fork's link. */
const FORK_TASK = 'forkTask';
const HAND_OFF = 'handOff';
const OPEN_FORK = 'openFork:';

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

      .rename-input {
        flex: 1;
        min-width: 6ch;
        margin: 0;
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        border: 1px solid var(--wa-color-brand-border-normal);
        border-radius: var(--border-radius-small);
        background: var(--wa-color-surface-default);
        color: var(--wa-color-text-normal);
        font: inherit;
        font-size: var(--font-size);
        font-weight: var(--font-weight-semibold);
      }

      .forked-from {
        flex: 0 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        border: none;
        border-radius: var(--border-radius-small);
        background: var(--wa-color-neutral-fill-quiet);
        font: inherit;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        cursor: pointer;
      }
      .forked-from:hover {
        color: var(--color-text-link);
      }

      .handoff {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-xs) 0;
      }
      .handoff-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs);
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
        .forked-from,
        wa-tag.progress-badge {
          display: none;
        }
      }
    `,
    runGrantStyles,
  ];

  @property({ attribute: false }) run: RunView | null = null;
  /** For the per-run policy snapshot behind the grant chips. */
  @property({ attribute: false }) view: SessionView | null = null;
  /** The shell's window items, after the run's actions in its menu. */
  @property({ attribute: false }) menuItems: readonly HeaderMenuItem[] = [];
  /** A document task's planned pass count, from the agent catalog. */
  @property({ attribute: false }) plannedPasses: number | undefined;

  /** The title is a field while the user renames the run. */
  @state() private renaming = false;
  /** The handoff's text is being written, under the header row. */
  @state() private handingOff = false;

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

  /** The rename field and the handoff form belong to the run they were
   *  opened on: showing another run closes them. */
  protected override willUpdate(changed: PropertyValues<this>): void {
    const previous = changed.get('run');
    if (previous !== undefined && previous?.id !== this.run?.id) {
      this.renaming = false;
      this.handingOff = false;
    }
  }

  private startRename(): void {
    this.renaming = true;
    void this.updateComplete.then(() => {
      const input =
        this.renderRoot.querySelector<HTMLInputElement>('.rename-input');
      input?.focus();
      input?.select();
    });
  }

  /** Enter or leaving the field saves a changed title; Esc keeps the old. */
  private finishRename(run: RunView, input: HTMLInputElement, save: boolean) {
    if (!this.renaming) return;
    this.renaming = false;
    const title = input.value.trim();
    if (!save || title === '' || title === run.title) return;
    this.dispatchEvent(
      SessionUiEvents.runtime({ kind: 'run.rename', runId: run.id, title }),
    );
  }

  private renderTitle(run: RunView): TemplateResult {
    if (this.renaming)
      return html`<input
        class="rename-input"
        aria-label="Task title"
        .value=${run.title}
        @keydown=${(event: KeyboardEvent) => {
          const input = event.target as HTMLInputElement;
          if (event.key === 'Enter') this.finishRename(run, input, true);
          else if (event.key === 'Escape') this.finishRename(run, input, false);
        }}
        @blur=${(event: FocusEvent) =>
          this.finishRename(run, event.target as HTMLInputElement, true)}
      />`;
    return html`<h1 id=${ELEMENT_IDS.ACTIVE_RUN_NAME} data-run=${run.id}>
        ${run.title}
      </h1>
      <wa-tooltip for=${ELEMENT_IDS.ACTIVE_RUN_NAME}>${run.label}</wa-tooltip>`;
  }

  /** The task this one was forked from, as the view names it. */
  private renderForkedFrom(run: RunView): TemplateResult | typeof nothing {
    const source = run.forkedFrom;
    if (source === null) return nothing;
    const from = this.view?.runs.get(source.id);
    const label = TASK_ACTIONS.forkedFrom(from ? from.title : 'a deleted task');
    return html`<button
      type="button"
      class="forked-from"
      title=${label}
      ?disabled=${from === undefined}
      @click=${() => this.navigateTo(source.id)}
    >
      ${waIcon('code-branch')} ${label}
    </button>`;
  }

  /** The handoff's text: the task continues from it alone, or, cleared
   *  with none, from the user's next message. */
  private renderHandoff(run: RunView): TemplateResult | typeof nothing {
    if (!this.handingOff) return nothing;
    const send = (handoff: string | null) => {
      this.handingOff = false;
      this.dispatchEvent(
        SessionUiEvents.runtime({ kind: 'run.reset', runId: run.id, handoff }),
      );
    };
    const text = () =>
      (
        this.renderRoot.querySelector<HTMLTextAreaElement>('.handoff-text')
          ?.value ?? ''
      ).trim();
    return html`<div class="handoff">
      <wa-textarea
        class="handoff-text"
        label="Hand off to a fresh context"
        hint="The task continues from this text alone: the model no longer sees the conversation before it. It takes effect when the task next waits for you."
        rows="3"
        resize="vertical"
        placeholder="What the task should know to continue…"
      ></wa-textarea>
      <div class="handoff-actions">
        <wa-button
          variant="brand"
          size="s"
          @click=${() => {
            const handoff = text();
            if (handoff !== '') send(handoff);
          }}
          >Hand off</wa-button
        >
        <wa-button appearance="outlined" size="s" @click=${() => send(null)}
          >Clear without a summary</wa-button
        >
        <wa-button
          appearance="plain"
          size="s"
          @click=${() => {
            this.handingOff = false;
          }}
          >Cancel</wa-button
        >
      </div>
    </div>`;
  }

  /** Whether a run grant is on, its own or its ancestry's. */
  private grantActive(run: RunView, kind: ApprovalBypassKind): boolean {
    return this.view != null && resolveBypass(this.view, run.id, kind) !== null;
  }

  /** Revoke one run grant; granting is the approval card's. */
  private revokeGrant(run: RunView, bypass: ApprovalBypassKind): void {
    this.dispatchEvent(
      SessionUiEvents.runtime({
        kind: 'policy.set',
        change: { field: 'bypass', runId: run.id, bypass, enabled: false },
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
    const passLabel = progressBadgeLabel(run, this.plannedPasses);

    return html`
      <div class="log-header">
        <slot name="start"></slot>
        ${this.renderAncestors(run)} ${this.renderTitle(run)}
        ${this.renderForkedFrom(run)}
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
            ? renderRunGrantChips(
                (kind) => this.grantActive(run, kind),
                (kind) => this.revokeGrant(run, kind),
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
        ${this.renderMenu(run, statusLabel, passLabel)}
      </div>
      ${this.renderHandoff(run)}
    `;
  }

  private renderMenu(
    run: RunView,
    statusLabel: string,
    passLabel: string | undefined,
  ): TemplateResult {
    // An agent run's menu lists a document task's or a conversation's
    // actions, a process's or a workflow container's the neutral ones, each
    // shown only while the run's `actions` holds it. The task's forks are
    // listed after them.
    const actions = (
      run.identity.kind === 'agent'
        ? runMenuActions(run.documentTask)
        : NEUTRAL_RUN_ACTIONS
    ).filter((action) => run.actions.includes(action.action));
    const copied = this.copyDiagnostics.state.copied;
    const canDelete = run.actions.includes('delete');
    const canRename = run.actions.includes('rename');
    const canFork = run.actions.includes('fork');
    const canHandOff = run.actions.includes('reset');
    const forks = [...(this.view?.runs.values() ?? [])].filter(
      (candidate) => candidate.forkedFrom?.id === run.id,
    );
    return html`
      <wa-dropdown
        placement="bottom-end"
        @wa-select=${(event: WaSelectEvent) => {
          const value = selectedItemValue(event);
          if (value === RENAME_TASK) {
            this.startRename();
            return;
          }
          if (value === FORK_TASK) {
            this.dispatchEvent(
              SessionUiEvents.host({ kind: 'fork', runId: run.id }),
            );
            return;
          }
          if (value === HAND_OFF) {
            this.handingOff = true;
            return;
          }
          const fork = forks.find(
            (candidate) => `${OPEN_FORK}${candidate.id}` === value,
          );
          if (fork) {
            this.navigateTo(fork.id);
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
          canRename
            ? html`<wa-dropdown-item value=${RENAME_TASK}
                >${waIcon('pencil', { slot: 'icon' })}${TASK_ACTIONS.rename}</wa-dropdown-item
              >`
            : nothing
        }
        ${
          canFork
            ? html`<wa-dropdown-item value=${FORK_TASK}
                >${waIcon('code-branch', { slot: 'icon' })}${TASK_ACTIONS.fork}</wa-dropdown-item
              >`
            : nothing
        }
        ${
          canHandOff
            ? html`<wa-dropdown-item value=${HAND_OFF}
                >${waIcon('arrow-right', { slot: 'icon' })}${TASK_ACTIONS.handOff}</wa-dropdown-item
              >`
            : nothing
        }
        ${repeat(
          forks,
          (fork) => fork.id,
          (fork) =>
            html`<wa-dropdown-item value=${`${OPEN_FORK}${fork.id}`}
              >${waIcon('code-branch', { slot: 'icon' })}${TASK_ACTIONS.openFork(
                fork.title,
              )}</wa-dropdown-item
            >`,
        )}
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
                  >${waIcon('trash', { slot: 'icon' })}${run.parentId === null ? TASK_ACTIONS.delete : TASK_ACTIONS.deleteAgent}</wa-dropdown-item
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
