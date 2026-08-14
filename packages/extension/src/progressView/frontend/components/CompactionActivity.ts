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

const ACTIVITY_ICON: Record<
  Exclude<CompactionActivityStatus, 'running'>,
  TeXRAIconName
> = {
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
        /* wa-spinner ignores color; it strokes via --indicator-color, a
           custom property that inherits through its shadow root. */
        --indicator-color: var(--wa-color-chart-blue);
      }

      .label {
        min-width: 0;
        overflow-wrap: break-word;
      }

      /* wa-spinner animates inside its own shadow root, so the wildcard
         reduced-motion rule in designTokens can't reach it. Its rotation
         lives on the svg exposed as ::part(base); stop it directly rather
         than approximating "off" through the --speed duration, which would
         leave the animation looping at an imperceptibly short but nonzero
         duration instead of actually stopping. */
      @media (prefers-reduced-motion: reduce) {
        wa-spinner::part(base) {
          animation: none;
        }
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
          ? html`<wa-spinner class="icon" aria-hidden="true"></wa-spinner>`
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
