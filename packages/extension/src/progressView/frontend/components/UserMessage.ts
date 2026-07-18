/**
 * UserMessage component for displaying user input messages.
 *
 * Renders a styled message bubble with timestamp and content.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles
import { compactIconActionButtonStyles } from '@shared/styles';
import { decodeXmlEntities } from '@shared/subagentFollowup';
import { DELIVERY_TAGS, type DeliveryTagName } from '@shared/deliveryTags';
import { CopyButtonController } from '@shared/litControllers/CopyButtonController';
import { designTokens } from '@shared/styles/litStyles';
import { markdownStyles } from '@shared/styles/markdownStyles';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';

// Local imports - formatter helpers
import { processMarkdownContent } from '../formatters/markdownRenderer';
import { formatDisplayTimestamp } from '../formatters/timestampUtils';

// Derived from the single owned DELIVERY_TAGS list (@shared/deliveryTags) so
// a new child-run kind only needs one entry there — see that module for the
// escaped-subset rationale.
const STRUCTURED_DELIVERY_TAGS = DELIVERY_TAGS.map((entry) => entry.tag);

const XML_ESCAPED_TAGS = new Set(
  DELIVERY_TAGS.filter((entry) => entry.escaped).map((entry) => entry.tag),
);

const STRUCTURED_DELIVERY_PATTERN = new RegExp(
  `^\\s*<(${STRUCTURED_DELIVERY_TAGS.join('|')})(\\s|>)`,
);

function getStructuredDeliveryTag(text: string): DeliveryTagName | null {
  // Safe cast: the pattern's only alternation group is STRUCTURED_DELIVERY_TAGS
  // (DeliveryTagName[]), so a match can only capture one of those values.
  return (
    (STRUCTURED_DELIVERY_PATTERN.exec(text)?.[1] as
      DeliveryTagName | undefined) ?? null
  );
}

@customElement('user-message')
export class UserMessage extends LitElement {
  static override styles = [
    designTokens,
    compactIconActionButtonStyles,
    markdownStyles,
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
        font-size: var(--font-size-sm);
        line-height: 1.35;
        white-space: normal;
      }

      .user-message-timestamp {
        font-size: var(--font-size-xs);
      }

      /*
       * High-contrast themes: the selection-background fill clashes with the
       * editor-foreground text (rendering the bubble unreadable) and the panel
       * border resolves to transparent. Fall back to the editor background plus
       * a solid contrast border so the message stays visible and delineated.
       */
      :host-context(.vscode-high-contrast) .user-message,
      :host-context(.vscode-high-contrast-light) .user-message {
        background-color: var(--wa-color-surface-default);
        border-color: var(
          --vscode-contrastBorder,
          var(--wa-color-surface-border)
        );
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
    structuredMarkdownHtml: '',
  };

  private getDisplayState(): {
    isStructuredDelivery: boolean;
    hasRawMessage: boolean;
    displayText: string;
    structuredMarkdownHtml: string;
  } {
    if (this.displayCache.text === this.text) {
      return this.displayCache;
    }

    const tag = getStructuredDeliveryTag(this.text);
    const isStructuredDelivery = tag != null;
    const hasRawMessage = tag != null && XML_ESCAPED_TAGS.has(tag);
    const displayText = hasRawMessage
      ? decodeXmlEntities(this.text)
      : this.text;

    this.displayCache = {
      text: this.text,
      isStructuredDelivery,
      hasRawMessage,
      displayText,
      // Cached alongside displayText: message text is immutable after
      // creation, so the Markdown parse must not rerun on every render.
      structuredMarkdownHtml: isStructuredDelivery
        ? processMarkdownContent(displayText)
        : '',
    };
    return this.displayCache;
  }

  override render(): TemplateResult {
    const { timeDisplay, tooltipTimestamp } = formatDisplayTimestamp(
      new Date(this.timestamp),
    );
    const copyState = this.copyController.state;
    const rawMessageCopyState = this.rawMessageCopyController.state;
    // processMarkdownContent uses MarkdownIt with html:false and escapes
    // restored LaTeX reference labels before the renderer output reaches
    // unsafeHTML.
    const {
      isStructuredDelivery,
      hasRawMessage,
      displayText,
      structuredMarkdownHtml,
    } = this.getDisplayState();

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
                library=${TEXRA_ICON_LIBRARY}
                name="comment"
                class="user-message-icon"
                aria-hidden="true"
              ></wa-icon>
              <span class="user-message-timestamp" title=${tooltipTimestamp}
                >${timeDisplay}</span
              >
            </span>
            ${renderIconActionButton({
              id: 'user-message-copy-button',
              icon: 'copy',
              label: copyState.ariaLabel,
              tooltip: copyState.title,
              className: `user-message-copy ${copyState.copied ? copyState.successClass : ''}`,
              onClick: () => this.copyController.copy(displayText),
            })}
            ${
              hasRawMessage
                ? renderIconActionButton({
                    id: 'user-message-raw-copy-button',
                    icon: 'code',
                    label: rawMessageCopyState.ariaLabel,
                    tooltip: rawMessageCopyState.title,
                    className: `user-message-copy ${rawMessageCopyState.copied ? rawMessageCopyState.successClass : ''}`,
                    onClick: () =>
                      this.rawMessageCopyController.copy(this.text),
                  })
                : nothing
            }
          </div>
          ${
            isStructuredDelivery
              ? html`<div
                  class="user-message-content markdown-content"
                  data-log-id=${this.logId}
                >
                  ${unsafeHTML(structuredMarkdownHtml)}
                </div>`
              : html`<div
                  class="user-message-content"
                  data-log-id=${this.logId}
                  .textContent=${displayText}
                ></div>`
          }
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
