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
import { customElement, property, state } from 'lit/decorators.js';

// Local imports
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

  @state() private _elapsed = '';

  private _intervalId: ReturnType<typeof setInterval> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._update();
    this._intervalId = setInterval(() => this._update(), 1000);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('startTime')) this._update();
  }

  private _update(): void {
    if (this.startTime <= 0) {
      this._elapsed = '';
      return;
    }
    // Lit's default `hasChanged` is `!==`, so an unchanged string schedules
    // no update on its own.
    this._elapsed = formatDuration(Date.now() - this.startTime);
  }

  override render(): TemplateResult | typeof nothing {
    if (!this._elapsed) return nothing;
    if (this.timeoutMs > 0) {
      const limit = formatDuration(this.timeoutMs);
      // prettier-ignore
      return html`<span class="timer" role="timer" aria-live="off" aria-label=${`Elapsed time: ${this._elapsed} of ${limit}`} dir="ltr">${this._elapsed}<span class="timer-limit"> / ${limit}</span></span>`;
    }
    return html`<span
      class="timer"
      role="timer"
      aria-live="off"
      aria-label=${`Elapsed time: ${this._elapsed}`}
      dir="ltr"
      >${this._elapsed}</span
    >`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tool-timer': ToolTimer;
  }
}
