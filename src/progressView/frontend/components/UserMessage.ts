/**
 * UserMessage component for displaying user input messages.
 *
 * Renders a styled message bubble with timestamp and content.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens } from '@shared/styles/litStyles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';

// Local imports - formatter helpers
import { formatTimestamp } from '../formatters/timestampUtils';

@customElement('user-message')
export class UserMessage extends LitElement {
  static override styles = [
    designTokens,
    codiconIconClasses,
    css`
      :host {
        display: flex;
        justify-content: flex-end;
        margin: var(--spacing-small) 0;
        padding-right: var(--spacing-tiny);
      }

      .user-message {
        background-color: var(--vscode-editor-selectionBackground);
        border-left: 3px solid var(--color-text-link);
        padding: var(--spacing-small) var(--spacing-medium);
        max-width: 85%;
        margin-left: var(--spacing-xlarge);
      }

      .user-message-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        margin-bottom: var(--spacing-tiny);
        font-size: var(--font-size-sm);
      }

      .user-message-icon {
        color: var(--color-text-link);
        font-size: var(--font-size-sm);
      }

      .user-message-content {
        color: var(--vscode-foreground);
        white-space: pre-wrap;
        word-wrap: break-word;
        line-height: 1.4;
      }

      .user-message-timestamp {
        font-size: var(--font-size-sm);
        color: var(--vscode-foreground);
        opacity: var(--opacity-subtle);
      }
    `,
  ];

  /** Message text content */
  @property({ type: String }) text = '';

  /** Log ID for tracking */
  @property({ type: String }) logId = '';

  /** Message timestamp (Unix ms) */
  @property({ type: Number }) timestamp = 0;

  override render(): TemplateResult {
    const { timeDisplay, tooltipTimestamp } = formatTimestamp(
      new Date(this.timestamp),
    );

    return html`
      <div class="user-message">
        <div class="user-message-header">
          <i class="codicon codicon-comment user-message-icon"></i>
          <span class="user-message-timestamp" title=${tooltipTimestamp}
            >${timeDisplay}</span
          >
        </div>
        <div class="user-message-content" data-log-id=${this.logId}>
          ${this.text}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'user-message': UserMessage;
  }
}
