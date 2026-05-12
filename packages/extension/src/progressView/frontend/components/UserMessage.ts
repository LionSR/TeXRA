/**
 * UserMessage component for displaying user input messages.
 *
 * Renders a styled message bubble with timestamp and content.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles
import { CopyButtonController } from '@shared/controllers';
import { compactIconActionButtonStyles } from '@shared/styles';
import { designTokens } from '@shared/styles/litStyles';
import { renderIconActionButton } from '@shared/wa/actionButtons';

// Local imports - formatter helpers
import { formatTimestamp } from '../formatters/timestampUtils';

const STRUCTURED_DELIVERY_TAGS = [
  'background-result',
  'background-error',
  'codex-result',
  'codex-error',
  'execution-activity',
  'github-webhook-activity',
  'subagent-progress',
  'subagent-result',
  'subagent-error',
] as const;

// Subset whose content is XML-entity-escaped and needs decoding for display.
// subagent-progress is included because the "todos" variant runs todo text
// through escapeText(), producing &amp;/&lt; entities in the body.
const XML_ESCAPED_TAGS = new Set([
  'background-result',
  'background-error',
  'codex-result',
  'codex-error',
  'subagent-progress',
  'subagent-result',
  'subagent-error',
]);

const STRUCTURED_DELIVERY_PATTERN = new RegExp(
  `^\\s*<(${STRUCTURED_DELIVERY_TAGS.join('|')})(\\s|>)`,
);

function getStructuredDeliveryTag(text: string): string | null {
  return STRUCTURED_DELIVERY_PATTERN.exec(text)?.[1] ?? null;
}

function decodeXmlEntitiesForDisplay(text: string): string {
  if (!text.includes('&')) return text;

  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

@customElement('user-message')
export class UserMessage extends LitElement {
  static override styles = [
    designTokens,
    compactIconActionButtonStyles,
    css`
      :host {
        display: block;
      }

      .user-message-container {
        display: flex;
        justify-content: flex-end;
        margin: var(--wa-space-3xs) 0;
      }

      .user-message {
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        max-width: 85%;
        background-color: var(--wa-color-editor-selection);
        border: var(--border-thin) solid var(--wa-color-surface-border);
        border-radius: var(--border-radius);
      }

      .user-message-header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        font-size: var(--font-size-xs);
        color: var(--wa-color-text-quiet);
      }

      .user-message-header-left {
        display: flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        flex: 1;
      }

      .user-message-copy {
        opacity: 0;
      }

      .user-message:hover .user-message-copy {
        opacity: 1;
      }

      .user-message-copy.copy-success {
        opacity: 1;
      }

      .user-message-icon {
        font-size: var(--font-size-xs);
      }

      .user-message-content {
        color: var(--wa-color-text-normal);
        white-space: pre-wrap;
        word-wrap: break-word;
        line-height: var(--line-height-normal);
        font-size: var(--font-size-sm);
      }

      .user-message--structured-delivery .user-message-content {
        max-height: min(45vh, 520px);
        overflow: auto;
        padding: var(--wa-space-2xs);
        background: var(
          --wa-color-surface-lowered,
          var(--wa-color-surface-default)
        );
        border-radius: var(--border-radius-small);
        font-family: var(
          --wa-font-family-mono,
          ui-monospace,
          SFMono-Regular,
          Consolas,
          monospace
        );
        font-size: var(--wa-editor-font-size, var(--font-size-sm));
        line-height: 1.35;
      }

      .user-message-timestamp {
        font-size: var(--font-size-xs);
      }
    `,
  ];

  /** Message text content */
  @property({ attribute: false }) text = '';

  /** Log ID for tracking */
  @property({ attribute: false }) logId = '';

  /** Message timestamp (Unix ms) */
  @property({ attribute: false }) timestamp = 0;

  private copyController = new CopyButtonController(this, {
    defaultTitle: 'Copy message',
  });

  private rawMessageCopyController = new CopyButtonController(this, {
    defaultTitle: 'Copy raw message',
  });

  private displayCache = {
    text: '',
    isStructuredDelivery: false,
    hasRawMessage: false,
    displayText: '',
  };

  private getDisplayState(): {
    isStructuredDelivery: boolean;
    hasRawMessage: boolean;
    displayText: string;
  } {
    if (this.displayCache.text === this.text) {
      return this.displayCache;
    }

    const tag = getStructuredDeliveryTag(this.text);
    const isStructuredDelivery = tag != null;
    const hasRawMessage = tag != null && XML_ESCAPED_TAGS.has(tag);
    const displayText = hasRawMessage
      ? decodeXmlEntitiesForDisplay(this.text)
      : this.text;

    this.displayCache = {
      text: this.text,
      isStructuredDelivery,
      hasRawMessage,
      displayText,
    };
    return this.displayCache;
  }

  override render(): TemplateResult {
    const { timeDisplay, tooltipTimestamp } = formatTimestamp(
      new Date(this.timestamp),
    );
    const copyState = this.copyController.state;
    const rawMessageCopyState = this.rawMessageCopyController.state;
    const { isStructuredDelivery, hasRawMessage, displayText } =
      this.getDisplayState();

    return html`
      <div class="user-message-container">
        <div
          class=${classMap({
            'user-message': true,
            'user-message--structured-delivery': isStructuredDelivery,
          })}
        >
          <div class="user-message-header">
            <span class="user-message-header-left">
              <wa-icon
                library="texra"
                name="comment"
                class="user-message-icon"
                aria-hidden="true"
              ></wa-icon>
              <span class="user-message-timestamp" title=${tooltipTimestamp}
                >${timeDisplay}</span
              >
            </span>
            ${renderIconActionButton({
              icon: 'copy',
              label: copyState.ariaLabel,
              title: copyState.title,
              className: `user-message-copy ${copyState.copied ? copyState.successClass : ''}`,
              onClick: () => this.copyController.copy(displayText),
            })}
            ${hasRawMessage
              ? renderIconActionButton({
                  icon: 'code',
                  label: rawMessageCopyState.ariaLabel,
                  title: rawMessageCopyState.title,
                  className: `user-message-copy ${rawMessageCopyState.copied ? rawMessageCopyState.successClass : ''}`,
                  onClick: () => this.rawMessageCopyController.copy(this.text),
                })
              : nothing}
          </div>
          <div
            class="user-message-content"
            data-log-id=${this.logId}
            .textContent=${displayText}
          ></div>
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
