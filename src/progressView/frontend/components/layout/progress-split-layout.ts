// Third-party imports
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';

/**
 * Layout container for the ProgressView.
 */
@customElement('progress-split-layout')
export class ProgressSplitLayout extends LitElement {
  protected createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <div class="main-container">
        <slot name="header"></slot>
        <slot name="prompt"></slot>
        <slot name="instruction"></slot>
        <slot name="content"></slot>
        <slot name="footer"></slot>
      </div>
    `;
  }
}
