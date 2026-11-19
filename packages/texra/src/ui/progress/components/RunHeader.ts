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

import {
  acceptsFollowUp,
  resolveBypass,
  joinFacts,
} from '@texra-ai/harness/schemas';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { CopyButtonController } from '@ui/litControllers/CopyButtonController';
import { runNoticeText, runStatus } from '@ui/copy/runStatus';
import { TASK_ACTIONS } from '@ui/copy/nestedRuns';
import { designTokens, commonViewStyles } from '@ui/styles';
import { truncateDeclarations } from '@ui/styles/commonViewStyles';
import { statusIndicatorStyles } from '@ui/styles/statusIndicatorStyles';
import {
  renderIconActionButton,
  renderIconActionButtonParts,
} from '@ui/wa/actionButtons';
import { actionMenu, type ActionMenuItem } from '@ui/wa/actionMenu';
import { inlineRenameField } from '@ui/wa/inlineRename';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import '@ui/progress/components/ToolTimer';
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
  type RunMenuTarget,
} from '../constants';
import { progressBadgeLabel } from '../formatters/progressBadgeFormatter';
import { renderRunGrantChips, runGrantStyles } from './runGrantChips';
import type {
  SessionView,
  RunView,
  ApprovalBypassKind,
  RunId,
} from '@texra-ai/harness/schemas';

/**
 * `<run-header>`: the one header row of a selected run. The
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
        flex: 0 1 auto;
        min-width: 6ch;
        margin: 0;
        ${truncateDeclarations}
        color: var(--wa-color-text-normal);
        font-size: var(--font-size);
        font-weight: var(--font-weight-semibold);
        line-height: var(--line-height-heading);
        letter-spacing: var(--letter-spacing-tight);
      }

      .rename-input {
        flex: 1;
        min-width: 6ch;
        margin: 0;
        font-weight: var(--font-weight-semibold);
      }

      /* A quiet chip that goes to a related run: the fork source, or one
         ancestor in the path. */
      .run-chip {
        flex: 0 1 auto;
        min-width: 0;
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        border: none;
        border-radius: var(--border-radius-small);
        background: var(--wa-color-neutral-fill-quiet);
        font: inherit;
        color: var(--color-text-secondary);
        cursor: pointer;
      }
      .run-chip:hover {
        color: var(--color-text-link);
      }
      .forked-from {
        ${truncateDeclarations}
        font-size: var(--font-size-xs);
      }

      .status-label,
      tool-timer {
        flex: 0 0 auto;
        white-space: nowrap;
      }
      .header-spacer {
        flex: 1;
        min-width: 0;
      }

      .status-indicator {
        margin: 0 var(--wa-space-3xs);
      }

      .stop-button {
        color: var(--color-error);
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
        font-size: var(--font-size-sm);
      }
      .ancestor-label {
        ${truncateDeclarations}
        min-width: 0;
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

      /* Keep the status word visible; secondary provenance and pass labels
         remain available from the menu when the pane is narrow. */
      @container (max-width: 640px) {
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
  /** The shell's window items (pop out, LaTeXDiffs), after the run's
   *  actions in its menu. */
  @property({ attribute: false }) menuItems: readonly ActionMenuItem[] = [];
  /** A document task's planned pass count, from the agent catalog. */
  @property({ attribute: false }) plannedPasses: number | undefined;

  /** The title is a field while the user renames the run. */
  @state() private renaming = false;

  private readonly copyDiagnostics = new CopyButtonController(this);

  /** What a run action reaches: this header's events and clipboard. */
  private readonly menuTarget: RunMenuTarget = {
    dispatchEvent: (event) => this.dispatchEvent(event),
    copy: (text) => void this.copyDiagnostics.copy(text),
  };

  /** The rename field belongs to the run it was opened on: showing another
   *  run closes it. */
  protected override willUpdate(changed: PropertyValues<this>): void {
    const previous = changed.get('run');
    if (previous !== undefined && previous?.id !== this.run?.id)
      this.renaming = false;
  }

  private startRename(): void {
    this.renaming = true;
  }

  private renderTitle(run: RunView): TemplateResult {
    if (this.renaming)
      return inlineRenameField({
        value: run.title,
        label: 'Task title',
        className: 'rename-input',
        onRename: (title) =>
          this.dispatchEvent(
            SessionUiEvents.runtime({
              kind: 'run.rename',
              runId: run.id,
              title,
            }),
          ),
        onClose: () => (this.renaming = false),
      });
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
    const label = TASK_ACTIONS.forkedFromRun(from);
    return html`<button
      type="button"
      class="run-chip forked-from"
      title=${label}
      ?disabled=${from === undefined}
      @click=${() => this.navigateTo(source.id)}
    >
      ${waIcon('code-branch')} ${label}
    </button>`;
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
    const status = runStatus(run);
    const canContinue =
      status.section !== 'running' &&
      status.section !== 'waiting' &&
      acceptsFollowUp(run);
    const statusLabel = canContinue ? 'Ready' : status.word;
    // The header offers exactly what the session view's `actions` licenses.
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
            [`tone-${canContinue ? 'neutral' : status.tone}`]: true,
          })}
        ></span>
        <wa-tooltip for=${ELEMENT_IDS.STATUS_INDICATOR}>
          ${
            canContinue
              ? `${status.word}. Send a message to continue.`
              : (runNoticeText(run) ?? statusLabel)
          }
        </wa-tooltip>
        <span class="status-label" aria-hidden="true">${statusLabel}</span>
        ${this.renderRunElapsed(run)} ${this.renderPassBadge(passLabel)}
        <span class="header-spacer"></span>
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
    `;
  }

  private renderMenu(
    run: RunView,
    statusLabel: string,
    passLabel: string | undefined,
  ): TemplateResult {
    // An agent run's menu lists a task's actions (the file entries only
    // for a document task) or a conversation's, a process's or a workflow
    // container's the neutral ones, each shown only while the run's
    // `actions` holds it. The task's forks are
    // listed after them.
    const actions = (
      run.identity.kind === 'agent' ? runMenuActions(run) : NEUTRAL_RUN_ACTIONS
    ).filter((action) => run.actions.includes(action.action));
    const { copied } = this.copyDiagnostics;
    const forks = [...(this.view?.runs.values() ?? [])].filter(
      (candidate) => candidate.forkedFrom?.id === run.id,
    );
    const items: ActionMenuItem[] = [
      ...(run.actions.includes('rename')
        ? [
            {
              icon: 'pencil',
              label: TASK_ACTIONS.rename,
              focusesOwn: true,
              activate: () => this.startRename(),
            } as const,
          ]
        : []),
      ...(run.actions.includes('fork')
        ? [
            {
              icon: 'code-branch',
              label: TASK_ACTIONS.fork,
              activate: () =>
                this.dispatchEvent(
                  SessionUiEvents.host({ kind: 'fork', runId: run.id }),
                ),
            } as const,
          ]
        : []),
      ...forks.map((fork) => ({
        icon: 'code-branch' as const,
        label: TASK_ACTIONS.openFork(fork.title),
        activate: () => this.navigateTo(fork.id),
      })),
      ...actions.map((action) => ({
        icon: action.action === 'copy' && copied ? 'check' : action.icon,
        label: action.label,
        activate: () => action.activate(run, this.menuTarget),
      })),
      ...this.menuItems,
      ...(run.actions.includes('delete')
        ? [
            {
              icon: 'trash',
              label: TASK_ACTIONS.delete(run),
              variant: 'danger',
              dividerBefore: true,
              activate: () =>
                this.dispatchEvent(
                  SessionUiEvents.runtime({
                    kind: 'run.delete',
                    runId: run.id,
                  }),
                ),
            } as const,
          ]
        : []),
    ];
    const menu = actionMenu(items);
    const more = renderIconActionButtonParts({
      id: ELEMENT_IDS.HEADER_MORE_BTN,
      icon: 'ellipsis',
      slot: 'trigger',
      label: 'Task actions',
      tooltip: 'Task actions',
    });
    return html`
      <wa-dropdown placement="bottom-end" @wa-select=${menu.onSelect}>
        ${more.button}
        <div class="menu-status">${joinFacts([statusLabel, passLabel])}</div>
        ${menu.items}
      </wa-dropdown>
      ${more.tooltip}
    `;
  }

  private renderRunElapsed(run: RunView): TemplateResult | typeof nothing {
    // The session view keeps a start only while the run works: no clock
    // otherwise.
    if (run.runStartedAt === null) return nothing;
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
              class="run-chip ancestor"
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
