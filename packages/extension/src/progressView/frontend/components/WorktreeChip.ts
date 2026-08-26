import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { type WorktreeInfo } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { getBasename } from '@utils/core';

import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

/**
 * Compact chip naming the worktree an agent runs in: the checked-out branch
 * (or the worktree folder when git metadata is absent), plus a dot when the
 * working tree has uncommitted changes.
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
        background-color: var(--color-chart-orange);
        flex-shrink: 0;
      }
    `,
  ];

  @property({ attribute: false }) info!: WorktreeInfo;

  override render(): TemplateResult | typeof nothing {
    if (!this.info) return nothing;
    return this.renderBranch();
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
}

declare global {
  interface HTMLElementTagNameMap {
    'worktree-chip': WorktreeChip;
  }
}
