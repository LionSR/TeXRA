/** Live elapsed-time timer for in-progress tool calls. */

// Third-party imports
import {
  LitElement,
  html,
  css,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports
import { TickerController } from '@shared/litControllers/TickerController';
import { formatDuration } from '@utils/core';

@customElement('tool-timer')
export class ToolTimer extends LitElement {
  static override styles = css`
    :host {
      display: inline;
    }
    .timer {
      font-size: var(--font-size-sm, 11px);
      opacity: var(--opacity-normal, 0.85);
      margin-inline-start: var(--wa-space-xs, 8px);
      font-variant-numeric: tabular-nums;
    }
    .timer-limit {
      opacity: var(--opacity-subtle, 0.7);
    }
  `;

  /** Start timestamp in milliseconds (Date.now() epoch). */
  @property({ attribute: false }) startTime = 0;

  /** Timeout limit in milliseconds. When set, displayed as "elapsed / limit". */
  @property({ attribute: false }) timeoutMs = 0;

  private readonly _ticker = new TickerController(this, 1000);

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('startTime')) this._ticker.refresh();
  }

  override render(): TemplateResult | typeof nothing {
    if (this.startTime <= 0) return nothing;
    const elapsed = formatDuration(this._ticker.now - this.startTime);
    if (this.timeoutMs > 0) {
      const limit = formatDuration(this.timeoutMs);
      // prettier-ignore
      return html`<span class="timer" role="timer" aria-live="off" aria-label=${`Elapsed time: ${elapsed} of ${limit}`} dir="ltr">${elapsed}<span class="timer-limit"> / ${limit}</span></span>`;
    }
    return html`<span
      class="timer"
      role="timer"
      aria-live="off"
      aria-label=${`Elapsed time: ${elapsed}`}
      dir="ltr"
      >${elapsed}</span
    >`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tool-timer': ToolTimer;
  }
}
