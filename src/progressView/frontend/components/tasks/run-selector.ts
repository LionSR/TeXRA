// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * Renders the active run indicator.
 */
@customElement('run-selector')
export class RunSelector extends LitElement {
  @property({ type: String })
  activeRunId: string | null = null;

  @property({ type: Array })
  runIds: string[] = [];

  protected createRenderRoot() {
    return this;
  }

  render() {
    if (!this.activeRunId && !this.runIds.length) {
      return html``;
    }

    return html`
      <div class="log-entry__meta">
        Active run: ${this.activeRunId ?? this.runIds.at(-1) ?? 'unknown'}
      </div>
    `;
  }
}
