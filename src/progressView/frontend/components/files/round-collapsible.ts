// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared schemas
import type { OutputFileInfo } from '@shared/schemas';

/**
 * Renders a round section for output files.
 */
@customElement('round-collapsible')
export class RoundCollapsible extends LitElement {
  @property({ type: String })
  round!: string;

  @property({ type: Array })
  files: OutputFileInfo[] = [];

  protected createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <div>
        <div class="log-entry__meta">Round ${this.round}</div>
        ${this.files.map((file) => html`<file-item .file=${file}></file-item>`)}
      </div>
    `;
  }
}
