import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import {
  WORKTREE_PR_STATE,
  WORKTREE_CI_STATE,
  type WorktreeInfo,
  type WorktreePRState,
  type WorktreeCIState,
} from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { getBasename } from '@utils/core';

import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

const PR_STATE_LABEL: Record<WorktreePRState, string> = {
  [WORKTREE_PR_STATE.OPEN]: 'Open',
  [WORKTREE_PR_STATE.MERGED]: 'Merged',
  [WORKTREE_PR_STATE.CLOSED]: 'Closed',
  [WORKTREE_PR_STATE.DRAFT]: 'Draft',
};

/** PR state → wa-badge variant (WA has no purple, so merged maps to brand). */
const PR_STATE_VARIANT: Record<
  WorktreePRState,
  'brand' | 'neutral' | 'success' | 'danger'
> = {
  [WORKTREE_PR_STATE.OPEN]: 'success',
  [WORKTREE_PR_STATE.MERGED]: 'brand',
  [WORKTREE_PR_STATE.CLOSED]: 'danger',
  [WORKTREE_PR_STATE.DRAFT]: 'neutral',
};

const CI_ICON: Record<WorktreeCIState, TeXRAIconName> = {
  [WORKTREE_CI_STATE.PENDING]: 'circle-dot',
  [WORKTREE_CI_STATE.RUNNING]: 'circle-dot',
  [WORKTREE_CI_STATE.SUCCESS]: 'circle-check',
  [WORKTREE_CI_STATE.FAILURE]: 'circle-xmark',
  [WORKTREE_CI_STATE.UNKNOWN]: 'circle-dot',
};

const CI_LABEL: Record<WorktreeCIState, string> = {
  [WORKTREE_CI_STATE.PENDING]: 'CI pending',
  [WORKTREE_CI_STATE.RUNNING]: 'CI running',
  [WORKTREE_CI_STATE.SUCCESS]: 'CI passing',
  [WORKTREE_CI_STATE.FAILURE]: 'CI failing',
  [WORKTREE_CI_STATE.UNKNOWN]: 'CI status unknown',
};

/**
 * Compact chip that mirrors GitHub's PR row: state pill, `#NNN` title, and
 * `+A −D` diff stats with a CI dot. Falls back to a branch-only chip when
 * no PR is associated.
 */
@customElement('worktree-chip')
export class WorktreeChip extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        font-size: var(--font-size-xs);
        line-height: 1.4;
        min-width: 0;
        max-width: 100%;
      }

      /* Native wa-badge per PR state (quiet 'filled' appearance); compacted to
         the prior pill padding. Colour comes from the variant. */
      .pill {
        flex-shrink: 0;
      }

      .pill::part(base) {
        gap: var(--wa-space-3xs);
        padding: 0 var(--wa-space-2xs);
      }

      .branch {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        min-width: 0;
        color: var(--wa-color-text-quiet, var(--wa-color-text-normal));
      }

      .branch-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 16ch;
      }

      .dirty-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: var(--wa-color-chart-orange, #d18616);
        flex-shrink: 0;
      }

      .pr-number {
        color: var(--wa-color-text-quiet, var(--wa-color-text-normal));
        flex-shrink: 0;
      }

      .pr-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }

      .diff-stats {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
      }

      .diff-added {
        color: var(--color-success);
      }

      .diff-removed {
        color: var(--color-error);
      }

      .ci-icon {
        font-size: var(--font-size-xs);
        flex-shrink: 0;
      }

      .ci-icon.ci-success {
        color: var(--color-success);
      }

      .ci-icon.ci-failure {
        color: var(--color-error);
      }

      .ci-icon.ci-pending,
      .ci-icon.ci-running {
        color: var(--wa-color-chart-orange, #d18616);
      }

      .ci-icon.ci-unknown {
        color: var(--wa-color-text-quiet, var(--wa-color-text-normal));
      }
    `,
  ];

  @property({ attribute: false }) info!: WorktreeInfo;

  override render(): TemplateResult | typeof nothing {
    const info = this.info;
    if (!info) return nothing;

    const pr = info.pr;
    return html`
      ${pr ? this.renderPRPill(pr.state) : nothing} ${this.renderBranch()}
      ${pr ? this.renderPRDetails(pr) : nothing}
    `;
  }

  private renderPRPill(state: WorktreePRState): TemplateResult {
    return html`<wa-badge
      class="pill"
      variant=${PR_STATE_VARIANT[state]}
      appearance="filled"
      >${PR_STATE_LABEL[state]}</wa-badge
    >`;
  }

  private renderBranch(): TemplateResult | typeof nothing {
    const branch = this.info.branch ?? this.worktreeLabel();
    if (!branch) return nothing;
    const branchKind = this.info.branch ? 'Branch' : 'Worktree';
    const tooltip = this.info.dirty
      ? `${branchKind} ${branch} (uncommitted changes)`
      : `${branchKind} ${branch}`;
    return html`<span id="worktree-branch" class="branch">
        ${waIcon('code-branch')}
        <span class="branch-name">${branch}</span>
        ${
          this.info.dirty
            ? html`<span
                  class="dirty-dot"
                  role="img"
                  aria-label="uncommitted changes"
                ></span>
                <span class="visually-hidden">uncommitted changes</span>`
            : nothing
        }
      </span>
      <wa-tooltip for="worktree-branch">${tooltip}</wa-tooltip>`;
  }

  private worktreeLabel(): string | undefined {
    const path = this.info.workingDirectory?.trim();
    if (!path) return undefined;
    return getBasename(path) || path;
  }

  private renderPRDetails(pr: NonNullable<WorktreeInfo['pr']>): TemplateResult {
    const ci = pr.ciState;
    const showStats = pr.additions != null || pr.deletions != null;
    return html`
      <span class="pr-number">#${pr.number}</span>
      ${
        pr.title
          ? html`<span id="worktree-pr-title" class="pr-title">${pr.title}</span
              ><wa-tooltip for="worktree-pr-title">${pr.title}</wa-tooltip>`
          : nothing
      }
      ${
        showStats
          ? html`<span id="worktree-diff-stats" class="diff-stats">
                ${
                  pr.additions != null
                    ? html`<span class="diff-added">+${pr.additions}</span>`
                    : nothing
                }
                ${
                  pr.deletions != null
                    ? html`<span class="diff-removed">−${pr.deletions}</span>`
                    : nothing
                }
              </span>
              <wa-tooltip for="worktree-diff-stats">Lines changed</wa-tooltip>`
          : nothing
      }
      ${
        ci
          ? html`${waIcon(CI_ICON[ci], { id: 'worktree-ci-status', className: `ci-icon ci-${ci}`, label: CI_LABEL[ci] })}
              <wa-tooltip for="worktree-ci-status">${CI_LABEL[ci]}</wa-tooltip>`
          : nothing
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'worktree-chip': WorktreeChip;
  }
}
