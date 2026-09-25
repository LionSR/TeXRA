// One run row of the run list: its title, status glyph, rollup and the
// row actions (expand, resume, delete). `run-tabs` lays the rows out.
import {
  LitElement,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { when } from 'lit/directives/when.js';

// Local imports
import type { RunView } from '@shared/session/sessionView';
import { designTokens } from '@ui/styles';
import { focusRingStyles } from '@ui/styles/controlStyles';
import { AGENT_DECORATORS, getAgentCategoryDecorator } from '@ui/wa/icons';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
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
    `Status: ${run.approval === 'none' ? run.statusLabel : 'Approval required'}`,
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
  static override styles = [designTokens, focusRingStyles, runTabStyles];

  @property({ attribute: false }) run!: RunView;
  @property({ type: Boolean }) active = false;
  /** Children are shown beneath this row. */
  @property({ type: Boolean, reflect: true }) expanded = false;
  /** This row has a child list to expand. */
  @property({ type: Boolean }) expandable = false;
  /** Finished since the user last had it on screen. */
  @property({ type: Boolean }) unseen = false;

  private decorator = getAgentCategoryDecorator('toolUse');

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('run')) this.decorator = runDecorator(this.run);
  }

  override render(): TemplateResult {
    const run = this.run;
    const pendingApproval = run.approval !== 'none';
    const statusGlyph = pendingApproval
      ? 'triangle-exclamation'
      : TONE_ICONS[run.tone];
    const accessibleStatusLabel = pendingApproval
      ? 'Approval required'
      : run.statusLabel;
    const runTitle = run.description || run.label;
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
            aria-label=${buildTooltip(run)}
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
                  ? html`<span class="tab-rollup" aria-label=${childCountLabel}
                      ><wa-badge variant="neutral" appearance="outlined" pill
                        >${run.rollup.total}</wa-badge
                      >${
                        run.rollup.running > 0
                          ? html`<wa-badge variant="success" pill
                              >${run.rollup.running}</wa-badge
                            >`
                          : nothing
                      }</span
                    >`
                  : nothing
              }
              <span
                id="run-tab-status"
                class="tab-status"
                role="img"
                aria-label=${accessibleStatusLabel}
              >
                ${waIcon(statusGlyph, { className: 'tab-status-icon' })}
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
              ${when(
                run.isRemote,
                () => html`
                  ${waIcon(AGENT_DECORATORS.properties.remote.icon, { id: 'run-tab-remote', className: 'remote-agent' })}
                `,
              )}
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
        >${when(
          run.isRemote,
          () =>
            html`<wa-tooltip for="run-tab-remote"
              >${AGENT_DECORATORS.properties.remote.hint}</wa-tooltip
            >`,
        )}
        ${
          run.group === 'interrupted' && !run.readOnly
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
      </div>
    `;
  }
}
