// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';

// Local imports - main view
import { mainViewStyles } from '@webview/frontend/styles';

@customElement('getting-started-banner')
export class GettingStartedBanner extends LitElement {
  static styles = [
    designTokens,
    commonViewStyles,
    codiconStyles,
    mainViewStyles,
  ];

  @property({ type: Boolean }) visible = false;

  render(): TemplateResult {
    return html`
      <div
        id="gettingStartedBanner"
        class="getting-started-banner"
        style=${this.visible ? 'display: block' : 'display: none'}
      >
        <span class="getting-started-text">
          No files found in workspace. Try
          <a href="command:texra.openGettingStarted"
            >opening the getting started walkthrough</a
          >,
          <a href="command:texra.createSampleProject"
            >creating a sample project</a
          >,
          <a href="command:texra.cloneOverleafProject"
            >cloning an Overleaf project</a
          >, or
          <a href="command:texra.downloadArXivSource"
            >downloading an arXiv source</a
          >.
        </span>
      </div>
    `;
  }
}
