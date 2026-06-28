// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';

// Side-effect imports - Web Awesome components
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles and icons
import { designTokens, commonViewStyles } from '@shared/styles';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';
import { clamp } from '@utils/core';

/**
 * Visual-only mock of a context window utilization chip. Shows the
 * percentage of the model's context budget used by the current session,
 * with a hairline progress bar. No real token counting wired in.
 */
@customElement('texra-context-utilization-mock')
export class ContextUtilizationMock extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
      }

      .ctx-chip {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        padding: 2px var(--wa-space-2xs);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--wa-border-radius-m);
        background: var(--wa-color-surface-default, transparent);
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-quiet);
        font-variant-numeric: tabular-nums;
        line-height: 1;
        cursor: default;
      }

      .ctx-chip__icon {
        font-size: var(--font-size-icon-sm);
      }

      .ctx-chip__bar {
        position: relative;
        width: 48px;
        height: 4px;
        border-radius: 2px;
        background: var(--wa-color-neutral-fill-quiet);
        overflow: hidden;
      }

      .ctx-chip__fill {
        position: absolute;
        inset: 0;
        transform-origin: left center;
        background: var(--wa-color-brand-fill-loud);
        transition: transform 0.2s ease;
      }

      .ctx-chip--warn .ctx-chip__fill {
        background: var(--wa-color-warning-fill-loud);
      }

      .ctx-chip--danger {
        color: var(--wa-color-danger-on-quiet);
      }

      .ctx-chip--danger .ctx-chip__fill {
        background: var(--wa-color-danger-fill-loud);
      }

      .ctx-chip__numeric {
        white-space: nowrap;
      }
    `,
  ];

  /** 0–100. Visual only, no real measurement behind it. */
  @property({ type: Number }) percent = 12;

  /** Display tokens used; purely cosmetic. */
  @property({ type: String }) tokens = '24k / 200k';

  override render(): TemplateResult {
    const clamped = clamp(this.percent, 0, 100);
    const scale = (clamped / 100).toFixed(3);
    const title = `Context ${clamped}% used — ${this.tokens}`;
    return html`
      <span
        class=${classMap({
          'ctx-chip': true,
          'ctx-chip--warn': clamped >= 70 && clamped < 90,
          'ctx-chip--danger': clamped >= 90,
        })}
        title=${title}
        role="img"
        aria-label=${title}
      >
        <wa-icon
          class="ctx-chip__icon"
          library=${TEXRA_ICON_LIBRARY}
          name="chart-pie"
          variant="solid"
        ></wa-icon>
        <span class="ctx-chip__bar" aria-hidden="true">
          <span
            class="ctx-chip__fill"
            style=${styleMap({ transform: `scaleX(${scale})` })}
          ></span>
        </span>
        <span class="ctx-chip__numeric">${clamped}%</span>
      </span>
    `;
  }
}
