import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { type WorktreeInfo } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@ui/styles';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { getBasename } from '@utils/core';

import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

/** Compact chip naming the worktree folder an agent runs in. */
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
        line-height: var(--line-height-normal);
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
    `,
  ];

  @property({ attribute: false }) info!: WorktreeInfo;

  override render(): TemplateResult | typeof nothing {
    if (!this.info) return nothing;
    const path = this.info.workingDirectory.trim();
    const folder = getBasename(path) || path;
    if (!folder) return nothing;
    return html`<span id="worktree-branch" class="branch">
        ${waIcon('code-branch')}
        <bdi class="branch-name" dir="auto">${folder}</bdi>
      </span>
      <wa-tooltip for="worktree-branch"
        >Worktree: <bdi dir="auto">${folder}</bdi></wa-tooltip
      >`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'worktree-chip': WorktreeChip;
  }
}
