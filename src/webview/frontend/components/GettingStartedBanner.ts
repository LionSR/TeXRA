/**
 * Banner component for the getting started walkthrough.
 *
 * Displays an info banner with links to various getting started
 * actions when no files are found in the workspace.
 *
 * @fires dismiss-getting-started - When dismiss button is clicked
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';

// Local imports - shared utilities
import { COMMAND_LINKS } from '@shared/utils/uiConstants';

// Local imports - main view events
import { MainViewEvents } from '../events';

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
        background-color: var(--texra-inputValidation-infoBackground);
        color: var(--texra-inputValidation-infoForeground);
        border: var(--border-thin) solid var(--texra-inputValidation-infoBorder);
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

      .getting-started-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
    `,
  ];

  @property({ type: Boolean }) visible = false;

  private handleDismiss(): void {
    this.dispatchEvent(MainViewEvents.dismissGettingStarted());
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.visible) return nothing;

    return html`
      <div id="gettingStartedBanner" class="getting-started-banner">
        <div class="getting-started-header">
          <span class="getting-started-text">
            <strong>Welcome to TeXRA!</strong> No LaTeX files here yet — pick
            how you'd like to start:
          </span>
          <vscode-toolbar-button
            icon="close"
            title="Dismiss (can be re-enabled in settings)"
            aria-label="Dismiss getting started banner"
            @click=${this.handleDismiss}
          ></vscode-toolbar-button>
        </div>
        <ul class="getting-started-list">
          <li>
            <a href=${COMMAND_LINKS.RUN_SETUP_ASSISTANT}
              >Run the setup assistant agent</a
            >
            -- checks tools, credentials, and LaTeX setup
          </li>
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
