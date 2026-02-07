/**
 * Live elapsed-time timer for in-progress tool calls.
 *
 * Renders a ticking counter (e.g. "3s", "1min 12s") that updates every second.
 * When a timeout limit is provided, displays "elapsed / limit" so the user
 * can see how close the command is to being killed.
 * Automatically starts on connect and stops on disconnect.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports
import { formatDuration } from '../formatters/timestampUtils';

@customElement('tool-timer')
export class ToolTimer extends LitElement {
  static override styles = css`
    :host {
      display: inline;
    }
    .timer {
      font-size: var(--font-size-sm, 11px);
      opacity: 0.8;
      margin-left: 6px;
      font-variant-numeric: tabular-nums;
    }
    .timer-limit {
      opacity: 0.6;
    }
  `;

  /** Start timestamp in milliseconds (Date.now() epoch). */
  @property({ type: Number }) startTime = 0;

  /** Timeout limit in milliseconds. When set, displayed as "elapsed / limit". */
  @property({ type: Number }) timeoutMs = 0;

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

  private _update(): void {
    if (!this.startTime) return;
    const elapsed = Date.now() - this.startTime;
    this._elapsed = formatDuration(elapsed);
  }

  override render(): TemplateResult {
    if (!this._elapsed) return html``;
    if (this.timeoutMs > 0) {
      const limit = formatDuration(this.timeoutMs);
      // prettier-ignore
      return html`<span class="timer">${this._elapsed}<span class="timer-limit"> / ${limit}</span></span>`;
    }
    return html`<span class="timer">${this._elapsed}</span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tool-timer': ToolTimer;
  }
}
