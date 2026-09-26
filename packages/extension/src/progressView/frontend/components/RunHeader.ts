import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

import {
  APPROVAL_BYPASS_KINDS,
  type ApprovalBypassKind,
} from '@shared/approvalBypassKind';
import type { ConversationProgress, GoalState, RunId } from '@shared/schemas';
import { isPlainAgentIdentity, RUN_PHASE, RUN_SUBSTATE } from '@shared/schemas';
import type { SessionView, RunView } from '@shared/session/sessionView';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { CopyButtonController } from '@shared/litControllers/CopyButtonController';
import {
  runStatusDisplayKey,
  type RunStatusDisplayKey,
} from '@shared/runs/runStatusDisplay';
import { formatWorkflowRunContext } from '@ui/copy/workflowRunContext';
import { designTokens, commonViewStyles } from '@ui/styles';
import { statusIndicatorStyles } from '@ui/styles/statusIndicatorStyles';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import type { TeXRAIconName } from '@ui/wa/iconNames';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import '@progressView/frontend/components/ToolTimer';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
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
import {
  renderProgressBadgeContent,
  getProgressBadgeTitle,
} from '../formatters/progressBadgeFormatter';
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

const ACTIVE_STATE_ACTIONS = [
  ELEMENT_IDS.STOP_STREAM_BTN,
  ELEMENT_IDS.AUTO_APPROVE,
  ELEMENT_IDS.COMPACT_RESPONSE_BTN,
  ELEMENT_IDS.OPEN_RUN_STORAGE_BTN,
  ELEMENT_IDS.EXPORT_TRANSCRIPT_BTN,
  ELEMENT_IDS.COPY_RUN_CONTEXT_BTN,
];

const TERMINAL_STATE_ACTIONS = [
  ELEMENT_IDS.RUN_NEW_BTN,
  ELEMENT_IDS.RESUME_BTN,
  ELEMENT_IDS.PACK_STREAM_BTN,
  ELEMENT_IDS.CLEAN_STREAM_BTN,
  ELEMENT_IDS.DIFF_STREAM_BTN,
  ELEMENT_IDS.OPEN_RUN_STORAGE_BTN,
  ELEMENT_IDS.EXPORT_TRANSCRIPT_BTN,
  ELEMENT_IDS.COPY_RUN_CONTEXT_BTN,
];

/** A run this process cannot act on: read and export only. */
const READ_ONLY_ACTIONS = new Set<string>([
  ELEMENT_IDS.OPEN_RUN_STORAGE_BTN,
  ELEMENT_IDS.EXPORT_TRANSCRIPT_BTN,
  ELEMENT_IDS.COPY_RUN_CONTEXT_BTN,
]);

const NOT_YET_RUN_ACTIONS = new Set<string>([
  ELEMENT_IDS.RESUME_BTN,
  ELEMENT_IDS.COPY_RUN_CONTEXT_BTN,
]);

/** Interrupted rows get the terminal set whatever their display key. */
const INTERRUPTED_ACTIONS: ReadonlySet<string> = new Set(
  TERMINAL_STATE_ACTIONS,
);

const ENABLED_ACTIONS_BY_DISPLAY_KEY: Record<
  RunStatusDisplayKey,
  Set<string>
> = {
  [RUN_SUBSTATE.STARTING]: new Set([
    ELEMENT_IDS.STOP_STREAM_BTN,
    ELEMENT_IDS.CLEAN_STREAM_BTN,
  ]),
  [RUN_PHASE.RUNNING]: new Set(ACTIVE_STATE_ACTIONS),
  [RUN_PHASE.FAILED]: new Set(TERMINAL_STATE_ACTIONS),
  [RUN_PHASE.COMPLETED]: new Set(TERMINAL_STATE_ACTIONS),
  [RUN_PHASE.CANCELLED]: new Set(TERMINAL_STATE_ACTIONS),
  ready: new Set(
    TERMINAL_STATE_ACTIONS.filter((id) => !NOT_YET_RUN_ACTIONS.has(id)),
  ),
  [RUN_PHASE.WAITING]: new Set(ACTIVE_STATE_ACTIONS),
  [RUN_SUBSTATE.RESUMING]: new Set(ACTIVE_STATE_ACTIONS),
};

const NATIVE_AGENT_ONLY_ACTIONS = new Set([
  ELEMENT_IDS.RESUME_BTN,
  ELEMENT_IDS.RUN_NEW_BTN,
]);

/** The menu value of the delete item, which asks before it acts. */
const DELETE_SESSION = 'deleteSession';

/** The status dot's hue per tone (G4: the fold spells the tone). */
const TONE_INDICATOR_CLASS: Record<RunView['tone'], string> = {
  running: 'is-running',
  success: 'is-completed',
  danger: 'is-failed',
  warning: 'is-starting',
  neutral: 'is-ready',
};

/** Which run actions a run's state licenses. */
function enabledRunActions(
  run: RunView,
  displayKey: RunStatusDisplayKey,
): ReadonlySet<string> | undefined {
  if (run.readOnly) return READ_ONLY_ACTIONS;
  if (run.group === 'interrupted') return INTERRUPTED_ACTIONS;
  return ENABLED_ACTIONS_BY_DISPLAY_KEY[displayKey];
}

/**
 * `<run-header>`: the one header row of a selected run (PRD 12.1). The
 * shell slots its own controls around it (the Sessions button at `start`,
 * New task at `end`), so a run never shows two rows of chrome: path and
 * title, status, time, an active run grant, Stop, and one menu holding the
 * run's actions, the shell's window items, and last, Delete session.
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

      .delete-confirm {
        margin: var(--wa-space-2xs) 0;
      }
      .delete-confirm-actions {
        display: flex;
        gap: var(--wa-space-2xs);
        margin-top: var(--wa-space-2xs);
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
      wa-tag.progress-badge wa-icon {
        font-size: var(--font-size-xs);
      }

      wa-tag.progress-badge {
        font-variant-numeric: tabular-nums;
      }

      /* A narrow row keeps the title: the status word and the tool-call
         count move into the menu's status line. */
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

  /** The delete item was chosen; the row asks before it acts. */
  @state() private confirmingDelete: RunId | null = null;

  private readonly width = new WideHeaderController(this);

  private readonly copyRunContext = new CopyButtonController(this, {
    successTitle: 'Copied!',
  });

  private runContextText(run: RunView): string {
    if (run.category !== 'workflow') return '';
    return formatWorkflowRunContext({
      run: {
        label: run.label,
        model: run.model ?? undefined,
        modelLabel: run.modelLabel ?? undefined,
        runId: run.id,
        description: run.description ?? undefined,
      },
      files: run.files,
      compileFailures: run.compileFailures,
    });
  }

  /** Send what a run action names (see `RunMenuAction.arm`). */
  private dispatchAction(action: RunMenuAction, run: RunView): void {
    const runId = run.id;
    if (action.arm === 'copyRunContext') {
      void this.copyRunContext.copy(this.runContextText(run));
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
    const displayKey = runStatusDisplayKey(
      run.status,
      run.substate ?? undefined,
    );
    const statusLabel = run.statusLabel;
    const goal: GoalState =
      run.category === 'toolUse' ? run.goal : { active: false };
    const enabled = enabledRunActions(run, displayKey);
    const canStop = enabled?.has(ELEMENT_IDS.STOP_STREAM_BTN) === true;
    // A run grant means something only on a live tool-use run this window
    // holds: read-only, interrupted and ended runs take none.
    const canGrant =
      enabled?.has(ELEMENT_IDS.AUTO_APPROVE) === true &&
      run.category === 'toolUse' &&
      run.identity.kind === 'agent';
    const progressTitle = getProgressBadgeTitle(
      run.conversationProgress,
      run.flow,
    );

    return html`
      <div class="log-header">
        <slot name="start"></slot>
        ${this.renderAncestors(run)}
        <h1 id=${ELEMENT_IDS.ACTIVE_RUN_NAME} data-run=${run.id}>
          ${run.description || run.label}
        </h1>
        <wa-tooltip for=${ELEMENT_IDS.ACTIVE_RUN_NAME}
          >${run.label} · ${run.id}</wa-tooltip
        >
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
        ${this.renderProgressBadge(run.conversationProgress, run.flow)}
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
                    }),
                  ),
              })
            : nothing
        }
        <slot name="end"></slot>
        ${this.renderMenu(run, enabled, statusLabel, progressTitle, canGrant)}
      </div>
      ${this.confirmingDelete === run.id ? this.renderDeleteConfirm(run) : nothing}
    `;
  }

  private renderMenu(
    run: RunView,
    enabled: ReadonlySet<string> | undefined,
    statusLabel: string,
    progressTitle: string | undefined,
    canGrant: boolean,
  ): TemplateResult {
    // An agent run takes its category's actions; a process or a workflow
    // container takes the neutral ones. Resume and Run again reach the
    // host's `nativeAgentRun` gate, which admits a plain agent identity and
    // nothing else. Edit as new task lives in the conversation's ended line.
    const actions = (
      run.identity.kind === 'agent'
        ? RUN_MENU_ACTIONS[run.category]
        : NEUTRAL_RUN_ACTIONS
    ).filter(
      (action) =>
        !NATIVE_AGENT_ONLY_ACTIONS.has(action.id) ||
        isPlainAgentIdentity(run.identity),
    );
    const runContext = this.runContextText(run);
    const copied = this.copyRunContext.state.copied;
    // A run still going is stopped first; deleting it is never offered.
    const canDelete = run.group !== 'running' && run.group !== 'waiting';
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
            this.confirmingDelete = run.id;
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
          ${statusLabel}${progressTitle ? ` · ${progressTitle}` : ''}
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
            const isCopy = action.arm === 'copyRunContext';
            return html`<wa-dropdown-item
              value=${action.id}
              ?disabled=${
                !enabled?.has(action.id) || (isCopy && runContext === '')
              }
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
                  >${waIcon('trash', { slot: 'icon' })}Delete
                  session…</wa-dropdown-item
                >`
            : nothing
        }
      </wa-dropdown>
      <wa-tooltip for=${ELEMENT_IDS.HEADER_MORE_BTN}>More</wa-tooltip>
    `;
  }

  private renderDeleteConfirm(run: RunView): TemplateResult {
    const cancel = (): void => {
      this.confirmingDelete = null;
    };
    return html`<wa-callout
      class="delete-confirm"
      variant="danger"
      size="small"
      role="alertdialog"
      aria-label="Delete session"
    >
      ${waIcon('trash', { slot: 'icon' })} Delete “${run.label}”? Its
      conversation and run folder are removed for good.
      <div class="delete-confirm-actions">
        <wa-button
          id="confirmDeleteSession"
          variant="danger"
          size="s"
          @click=${() => {
            this.confirmingDelete = null;
            this.dispatchEvent(
              SessionUiEvents.runtime({ kind: 'run.delete', runId: run.id }),
            );
          }}
          >Delete</wa-button
        >
        <wa-button appearance="plain" size="s" @click=${cancel}
          >Cancel</wa-button
        >
      </div>
    </wa-callout>`;
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

  private renderProgressBadge(
    progress: ConversationProgress | undefined,
    flow: RunView['flow'],
  ): TemplateResult | typeof nothing {
    const content = renderProgressBadgeContent(progress, flow);
    if (content === nothing) return nothing;
    const progressTitle = getProgressBadgeTitle(progress, flow);
    return html`<wa-tag
        id=${ELEMENT_IDS.PROGRESS_BADGE}
        class="progress-badge"
        variant="neutral"
        size="s"
      >
        ${waIcon('chart-line')} ${content}
      </wa-tag>
      ${
        progressTitle
          ? html`<wa-tooltip for=${ELEMENT_IDS.PROGRESS_BADGE}
              >${progressTitle}</wa-tooltip
            >`
          : nothing
      }`;
  }

  /** The full ancestors path, root first, each segment a link to that
   *  run. Laid out nearest-first in the DOM (see the styles). */
  private renderAncestors(run: RunView): TemplateResult | typeof nothing {
    if (run.ancestors.length === 0) return nothing;
    const nearestFirst = run.ancestors.toReversed();
    return html`
      <nav class="ancestors" aria-label="Parent sessions">
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
              >Go to ${ancestor.label} · ${ancestor.id}</wa-tooltip
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
