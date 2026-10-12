// One run row of the run list: its title, status glyph, rollup and the
// row actions (expand, and, where the list is `removable`, delete). An
// interrupted row says so; its one Resume is on the task's ended line, which
// the row opens. `run-tabs` lays the rows out.
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
import type { RunView } from '@shared/session/sessionView';
import { type TeXRAIconName } from '@shared/iconNames';
import { SessionUiEvents } from '@texra/shared/session/uiEvents';
import { designTokens } from '@ui/styles';
import {
  buttonStyles,
  focusRingStyles,
  formControlStyles,
} from '@ui/styles/controlStyles';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import { afterDropdownHides } from '@ui/wa/selectTemplates';
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
import { NESTED_AGENT, TASK_ACTIONS } from '@ui/copy/nestedRuns';
import { getBasename } from '@utils/core';
import { formatRelativeTime, formatResultCount } from '@utils/text/stringUtils';
import { runTabStyles } from './RunTab.styles';

/** Shape cue per tone (G4: the fold spells the tone, the host the glyph). */
const TONE_ICONS: Record<RunView['tone'], TeXRAIconName> = {
  running: 'circle',
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
    ? `Worktree: ${getBasename(worktree.workingDirectory)}`
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
  // No raw id: two parallel agents differ by title, model and time, and
  // the id is for bug reports ("Copy diagnostics").
  return [
    mainLine,
    run.description,
    run.statusDetail,
    lastSeen && `Last activity ${lastSeen}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** A collapsed parent's descendants in words: "2 agents · 1 running". */
function rollupLabel(run: RunView): string {
  const total = formatResultCount(run.rollup.total, NESTED_AGENT.countNoun);
  return run.rollup.running > 0
    ? `${total} · ${run.rollup.running} running`
    : total;
}

function runDecorator(run: RunView) {
  const kind = run.identity.kind;
  return kind === 'agent'
    ? AGENT_DECORATORS.agentRuns[run.documentTask ? 'task' : 'chat']
    : AGENT_DECORATORS.streamKinds[kind];
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
    buttonStyles,
    focusRingStyles,
    formControlStyles,
    runTabStyles,
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
  /** The row offers Delete (the desktop rail); set only on a run whose
   *  `actions` hold `delete`. */
  @property({ type: Boolean }) removable = false;
  @state() private renaming = false;

  private startRename(): void {
    if (!this.run.actions.includes('rename')) return;
    this.renaming = true;
    void this.updateComplete.then(() => {
      const input =
        this.renderRoot.querySelector<HTMLInputElement>('.tab-rename');
      input?.focus();
      input?.select();
    });
  }

  private finishRename(input: HTMLInputElement, save: boolean): void {
    if (!this.renaming) return;
    this.renaming = false;
    const title = input.value.trim();
    if (save && title && title !== (this.run.description || this.run.label)) {
      this.dispatchEvent(
        SessionUiEvents.runtime({
          kind: 'run.rename',
          runId: this.run.id,
          title,
        }),
      );
    }
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
    const pendingApproval = run.approval !== 'none';
    const showStatus = pendingApproval || run.tone !== 'neutral';
    const statusGlyph = pendingApproval
      ? 'triangle-exclamation'
      : TONE_ICONS[run.tone];
    const accessibleStatusLabel = pendingApproval
      ? 'Needs approval'
      : run.statusLabel;
    const runTitle = run.title;
    const tooltip = buildTooltip(run);
    const deleteLabel =
      run.parentId === null ? TASK_ACTIONS.delete : TASK_ACTIONS.deleteAgent;
    const childCountLabel = formatResultCount(
      run.rollup.total,
      NESTED_AGENT.countNoun,
    );
    const childToggleLabel = this.expanded
      ? NESTED_AGENT.collapseAction
      : childCountLabel;
    const metaAgentName =
      run.identity.kind === 'agent' && run.description ? run.label : undefined;
    // The rollup is the row's own fact: the rail carries it with no
    // disclosure at all (W2), and a tree row hides it while open.
    const showRollup = run.rollup.total > 0 && !this.expanded;

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
          [`tone-${run.tone}`]: true,
          'has-pending-approval': pendingApproval,
          'is-read-only': run.readOnly,
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
                  >${waIcon('chevron-right')}</wa-button
                ><wa-tooltip for="run-tab-expand-button"
                  >${childToggleLabel}</wa-tooltip
                >`
            : nothing
        }
        <div class="tab-select-tooltip-anchor">
          ${
            this.renaming
              ? html`<input
                  class="tab-rename inline-rename"
                  aria-label="Task title"
                  .value=${runTitle}
                  @keydown=${(event: KeyboardEvent) => {
                    event.stopPropagation();
                    if (event.key === 'Enter')
                      this.finishRename(event.target as HTMLInputElement, true);
                    if (event.key === 'Escape')
                      this.finishRename(
                        event.target as HTMLInputElement,
                        false,
                      );
                  }}
                  @blur=${(event: FocusEvent) => this.finishRename(event.target as HTMLInputElement, true)}
                />`
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
          ${showStatus ? html`<wa-tooltip for="run-tab-status">${accessibleStatusLabel}</wa-tooltip>` : nothing}
        </div>
        ${
          showStatus
            ? html`<span
                id="run-tab-status"
                class="tab-status"
                role="img"
                aria-label=${accessibleStatusLabel}
              >
                ${waIcon(statusGlyph, { className: 'tab-status-icon' })}
                ${pendingApproval ? html`<span class="tab-status-label">Needs approval</span>` : nothing}
              </span>`
            : nothing
        }
        <wa-tooltip for="run-tab-kind">${this.decorator.label}</wa-tooltip>
        ${
          this.removable || run.actions.includes('rename')
            ? html`<wa-dropdown
                class="tab-actions"
                placement="bottom-end"
                @wa-select=${(
                  event: CustomEvent<{ item: { value: string } }>,
                ) => {
                  event.stopPropagation();
                  if (event.detail.item.value === 'rename')
                    afterDropdownHides(event, () => this.startRename());
                  if (event.detail.item.value === 'delete') {
                    this.dispatchEvent(
                      new CustomEvent('run-row-delete', {
                        bubbles: true,
                        composed: true,
                      }),
                    );
                  }
                }}
              >
                ${renderIconActionButton({
                  id: 'run-tab-actions',
                  icon: 'ellipsis',
                  slot: 'trigger',
                  label: `Actions for ${run.identity.kind === 'agent' ? 'agent' : 'task'} ${runTitle}`,
                  tooltip:
                    run.identity.kind === 'agent'
                      ? 'Agent actions'
                      : 'Task actions',
                })}
                ${run.actions.includes('rename') ? html`<wa-dropdown-item value="rename">${waIcon('pencil', { slot: 'icon' })}Rename…</wa-dropdown-item>` : nothing}
                ${this.removable ? html`<wa-dropdown-item class="tab-remove" value="delete" variant="danger">${waIcon('trash', { slot: 'icon' })}${deleteLabel}</wa-dropdown-item>` : nothing}
              </wa-dropdown>`
            : nothing
        }
      </div>
    `;
  }
}
