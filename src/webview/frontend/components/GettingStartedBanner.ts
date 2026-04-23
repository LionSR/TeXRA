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
import { infoNoticeStyles } from '../styles/infoNoticeStyles';
import { renderInfoNotice } from './infoNotice';

@customElement('getting-started-banner')
export class GettingStartedBanner extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    infoNoticeStyles,
    css`
      .info-notice a {
        color: var(--color-text-link);
        text-decoration: none;
      }

      .info-notice a:hover {
        text-decoration: underline;
      }

      .getting-started-list {
        margin: var(--spacing-tiny) 0 0 0;
        padding-left: var(--spacing-large);
        line-height: var(--line-height-relaxed);
      }

      .getting-started-header {
        font-weight: var(--font-weight-semibold);
      }
    `,
  ];

  @property({ type: Boolean }) visible = false;

  private handleDismiss(): void {
    this.dispatchEvent(MainViewEvents.dismissGettingStarted());
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.visible) return nothing;

    return renderInfoNotice({
      id: 'gettingStartedBanner',
      ariaLabel: 'Getting started guidance',
      variant: 'banner',
      content: html`
        <span class="getting-started-header">
          <strong>Welcome to TeXRA!</strong> Open a workspace with LaTeX files,
          or get started with one of these:
        </span>
      `,
      secondary: html`
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
      `,
      dismiss: {
        title: 'Dismiss (can be re-enabled in settings)',
        ariaLabel: 'Dismiss getting started banner',
        onDismiss: this.handleDismiss,
      },
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'getting-started-banner': GettingStartedBanner;
  }
}
