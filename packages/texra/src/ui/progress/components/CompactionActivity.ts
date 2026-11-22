import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { COMPACTION_ACTIVITY_TONE, statusGlyph } from '@ui/copy/runStatus';
import { TexraElement } from '@ui/litBase';
import { toneStyles } from '@ui/styles/toneStyles';
import { waSpinner } from '@ui/wa/spinner';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import type { CompactionActivityStatus } from '@texra-ai/worldline/transcript';

/** Non-collapsible transcript activity row for one context compaction. */
@customElement('compaction-activity')
export class CompactionActivity extends TexraElement {
  static override styles = [
    TexraElement.styles,
    toneStyles,
    css`
      :host {
        display: block;
        margin: var(--wa-space-2xs) 0;
      }

      .activity {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        min-width: 0;
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        border-radius: var(--border-radius-small);
        background: var(--wa-color-surface-raised);
        color: var(--wa-color-text-normal);
        font-size: var(--font-size-sm);
        line-height: var(--line-height-normal);
      }

      .icon {
        flex: 0 0 auto;
        color: var(--tone-color);
        /* wa-spinner ignores color; it strokes via --indicator-color, a
           custom property that inherits through its shadow root. */
        --indicator-color: var(--tone-color);
      }

      .label {
        min-width: 0;
        overflow-wrap: break-word;
      }
    `,
  ];

  @property({ attribute: false }) status: CompactionActivityStatus = 'running';
  /** The row's label (`compactionActivityRow`), figures included. */
  @property({ attribute: false }) label = '';

  override render(): TemplateResult {
    const tone = COMPACTION_ACTIVITY_TONE[this.status];
    return html`<div
      class=${`activity tone-${tone}`}
      role="status"
      aria-live="polite"
    >
      ${
        this.status === 'running'
          ? waSpinner('icon')
          : waIcon(statusGlyph({ tone }), { className: 'icon' })
      }
      <span class="label">${this.label}</span>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'compaction-activity': CompactionActivity;
  }
}
