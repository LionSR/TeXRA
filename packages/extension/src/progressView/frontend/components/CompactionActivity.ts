import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';

import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import {
  COMPACTION_ACTIVITY_LABEL,
  type CompactionActivityStatus,
} from '@shared/streams/compactionActivityProjection';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';

const ACTIVITY_ICON: Record<CompactionActivityStatus, TeXRAIconName> = {
  running: 'arrows-rotate',
  completed: 'circle-check',
  failed: 'circle-xmark',
  cancelled: 'ban',
  skipped: 'circle-info',
  interrupted: 'circle-exclamation',
};

/** Non-collapsible transcript activity row for one context compaction. */
@customElement('compaction-activity')
export class CompactionActivity extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
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
        line-height: 1.4;
      }

      .icon {
        flex: 0 0 auto;
        color: var(--wa-color-text-quiet, var(--wa-color-text-normal));
      }

      .activity--completed .icon {
        color: var(--color-success);
      }

      .activity--failed .icon {
        color: var(--color-error);
      }

      .activity--running .icon {
        color: var(--wa-color-chart-blue);
      }

      .label {
        min-width: 0;
        overflow-wrap: break-word;
      }
    `,
  ];

  @property({ attribute: false }) status: CompactionActivityStatus = 'running';

  override render(): TemplateResult {
    const label = COMPACTION_ACTIVITY_LABEL[this.status];
    return html`<div
      class=${`activity activity--${this.status}`}
      role="status"
      aria-live="polite"
    >
      ${
        this.status === 'running'
          ? html`<wa-spinner class="icon"></wa-spinner>`
          : waIcon(ACTIVITY_ICON[this.status], { className: 'icon' })
      }
      <span class="label">${label}</span>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'compaction-activity': CompactionActivity;
  }
}
