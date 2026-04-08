/**
 * Banner component for the getting started walkthrough.
 *
 * Displays an info banner with links to various getting started
 * actions when no files are found in the workspace.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';

// Local imports - shared utilities
import { COMMAND_LINKS } from '@shared/utils/uiConstants';

@customElement('getting-started-banner')
export class GettingStartedBanner extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .getting-started-banner {
        border-radius: var(--border-radius);
        padding: var(--spacing-small) var(--spacing-medium);
        margin-bottom: var(--spacing-large);
        background-color: var(--vscode-inputValidation-infoBackground);
        color: var(--vscode-inputValidation-infoForeground);
        border: var(--border-thin) solid
          var(--vscode-inputValidation-infoBorder);
        line-height: var(--line-height-relaxed);
      }

      .getting-started-banner a {
        color: var(--color-text-link);
        text-decoration: none;
      }

      .getting-started-banner a:hover {
        text-decoration: underline;
      }
    `,
  ];

  @property({ type: Boolean }) visible = false;

  override render(): TemplateResult | typeof nothing {
    if (!this.visible) return nothing;

    return html`
      <div id="gettingStartedBanner" class="getting-started-banner">
        <span class="getting-started-text">
          <strong>Welcome to TeXRA!</strong> To get started, open a workspace
          with LaTeX files or try one of these:
        </span>
        <ul
          style="margin: 4px 0 0 0; padding-left: 20px; line-height: 1.8;"
        >
          <li>
            <a href=${COMMAND_LINKS.GETTING_STARTED}
              >Open the getting started walkthrough</a
            >
            -- step-by-step setup guide
          </li>
          <li>
            <a href=${COMMAND_LINKS.CREATE_SAMPLE_PROJECT}
              >Create a sample project</a
            >
            -- bundled LaTeX files to experiment with
          </li>
          <li>
            <a href=${COMMAND_LINKS.CLONE_OVERLEAF}>Clone an Overleaf project</a
            >
            -- import an existing project
          </li>
          <li>
            <a href=${COMMAND_LINKS.DOWNLOAD_ARXIV}>Download an arXiv source</a>
            -- grab a paper's source files
          </li>
        </ul>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'getting-started-banner': GettingStartedBanner;
  }
}
