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

      .getting-started-list {
        margin: var(--spacing-tiny) 0 0 0;
        padding-left: var(--spacing-large);
        line-height: var(--line-height-relaxed);
      }
    `,
  ];

  @property({ type: Boolean }) visible = false;

  override render(): TemplateResult | typeof nothing {
    if (!this.visible) return nothing;

    return html`
      <div id="gettingStartedBanner" class="getting-started-banner">
        <span class="getting-started-text">
          <strong>Welcome to TeXRA!</strong> Open a workspace with LaTeX files,
          or get started with one of these:
        </span>
        <ul class="getting-started-list">
          <li>
            <a href=${COMMAND_LINKS.GETTING_STARTED}>Walk me through setup</a>
            -- takes a few minutes
          </li>
          <li>
            <a href=${COMMAND_LINKS.CREATE_SAMPLE_PROJECT}
              >Try the sample project</a
            >
            -- play around risk-free
          </li>
          <li>
            <a href=${COMMAND_LINKS.CLONE_OVERLEAF}>Pull from Overleaf</a>
            -- import an existing project
          </li>
          <li>
            <a href=${COMMAND_LINKS.DOWNLOAD_ARXIV}>Grab from arXiv</a>
            -- download a paper's source
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
