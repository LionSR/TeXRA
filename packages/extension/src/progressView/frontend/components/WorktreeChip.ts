import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

import {
  WORKTREE_PR_STATE,
  WORKTREE_CI_STATE,
  type WorktreeInfo,
  type WorktreePRState,
  type WorktreeCIState,
} from '@shared/schemas';
import { designTokens } from '@shared/styles';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import '@awesome.me/webawesome/dist/components/icon/icon.js';

const PR_STATE_LABEL: Record<WorktreePRState, string> = {
  [WORKTREE_PR_STATE.OPEN]: 'Open',
  [WORKTREE_PR_STATE.MERGED]: 'Merged',
  [WORKTREE_PR_STATE.CLOSED]: 'Closed',
  [WORKTREE_PR_STATE.DRAFT]: 'Draft',
};

const CI_ICON: Record<WorktreeCIState, string> = {
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

/** Trailing path segment, posix or windows. Webview-safe — no node:path.
 *  Falls back to the original input for separator-only paths (e.g. `/`)
 *  so callers always get a non-empty label. */
function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  if (!trimmed) return p;
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Compact chip that mirrors GitHub's PR row: state pill, `#NNN` title, and
 * `+A −D` diff stats with a CI dot. Falls back to a branch-only chip when
 * no PR is associated.
 */
@customElement('worktree-chip')
export class WorktreeChip extends LitElement {
  static override styles = [
    designTokens,
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

      .pill {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        padding: 0 var(--wa-space-2xs);
        border-radius: var(--border-radius-pill, 999px);
        background-color: color-mix(
          in srgb,
          var(--color-text-secondary) 12%,
          transparent
        );
        color: var(--wa-color-text-normal);
        white-space: nowrap;
        flex-shrink: 0;
      }

      .pill.state-open {
        color: var(--wa-color-success-on-quiet, var(--color-success));
        background-color: color-mix(
          in srgb,
          var(--color-success) 14%,
          transparent
        );
      }

      .pill.state-merged {
        color: var(--wa-color-chart-purple, var(--wa-color-text-link, #8957e5));
        background-color: color-mix(
          in srgb,
          var(--wa-color-chart-purple, #8957e5) 14%,
          transparent
        );
      }

      .pill.state-closed {
        color: var(--wa-color-danger-on-quiet, var(--color-error));
        background-color: color-mix(
          in srgb,
          var(--color-error) 14%,
          transparent
        );
      }

      .pill.state-draft {
        color: var(--wa-color-text-quiet, var(--wa-color-text-normal));
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
        color: var(--color-success, #1f883d);
      }

      .diff-removed {
        color: var(--color-error, #cf222e);
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
    return html`<span
      class=${classMap({ pill: true, [`state-${state}`]: true })}
      title=${`PR ${PR_STATE_LABEL[state]}`}
      >${PR_STATE_LABEL[state]}</span
    >`;
  }

  private renderBranch(): TemplateResult | typeof nothing {
    // Display name falls back to the basename of the working directory when
    // a branch hasn't resolved yet (or the path isn't a git repo), so the
    // chip never renders an empty row when `info.workingDirectory` is set.
    const branch = this.info.branch;
    const fallback = branch ? undefined : basename(this.info.workingDirectory);
    const display = branch ?? fallback;
    if (!display) return nothing;

    const tooltipBase = branch
      ? `Branch ${branch}`
      : this.info.workingDirectory;
    const tooltip = this.info.dirty
      ? `${tooltipBase} (uncommitted changes)`
      : tooltipBase;
    return html`<span class="branch" title=${tooltip}>
      ${waIcon('code-branch')}
      <span class="branch-name">${display}</span>
      ${this.info.dirty
        ? html`<span
            class="dirty-dot"
            role="img"
            aria-label="uncommitted changes"
          ></span>`
        : nothing}
    </span>`;
  }

  private renderPRDetails(pr: NonNullable<WorktreeInfo['pr']>): TemplateResult {
    const ci = pr.ciState ?? WORKTREE_CI_STATE.UNKNOWN;
    const titleAttr = pr.title ? `#${pr.number} ${pr.title}` : `#${pr.number}`;
    const showStats = pr.additions != null || pr.deletions != null;
    return html`
      <span class="pr-number" title=${titleAttr}>#${pr.number}</span>
      ${pr.title
        ? html`<span class="pr-title" title=${pr.title}>${pr.title}</span>`
        : nothing}
      ${showStats
        ? html`<span class="diff-stats" title="Lines changed">
            ${pr.additions != null
              ? html`<span class="diff-added">+${pr.additions}</span>`
              : nothing}
            ${pr.deletions != null
              ? html`<span class="diff-removed">−${pr.deletions}</span>`
              : nothing}
          </span>`
        : nothing}
      ${pr.ciState
        ? html`<wa-icon
            library="texra"
            name=${CI_ICON[ci]}
            class=${classMap({ 'ci-icon': true, [`ci-${ci}`]: true })}
            title=${CI_LABEL[ci]}
            aria-label=${CI_LABEL[ci]}
          ></wa-icon>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'worktree-chip': WorktreeChip;
  }
}
