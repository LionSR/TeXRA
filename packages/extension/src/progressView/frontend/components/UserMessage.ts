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
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import {
  decodeXmlEntities,
  deliveryTagOf,
  formatWorkflowScriptDeliverySummary,
} from '@shared/subagentFollowup';
import type { WorkflowScriptDeliverySummary } from '@shared/schemas';
import { DELIVERY_TAGS } from '@shared/deliveryTags';
import { CopyButtonController } from '@shared/litControllers/CopyButtonController';
import { buttonStyles, focusRingStyles } from '@shared/styles/controlStyles';
import { designTokens } from '@shared/styles/litStyles';
import { markdownStyles } from '@shared/styles/markdownStyles';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - formatter helpers
import { processMarkdownContent } from '../formatters/markdownRenderer';
import { formatDisplayTimestamp } from '../formatters/timestampUtils';

// Derived from the single owned DELIVERY_TAGS list (@shared/deliveryTags) so
// a new child-run kind only needs one entry there. See that module for the
// escaped-subset rationale.
const XML_ESCAPED_TAGS = new Set(
  DELIVERY_TAGS.filter((entry) => entry.escaped).map((entry) => entry.tag),
);

type DisplayState = {
  isStructuredDelivery: boolean;
  hasRawMessage: boolean;
  displayText: string;
  /** What the copy action yields: the presented content — the formatted
   *  workflow summary when one renders, the display text otherwise. */
  copyText: string;
  structuredMarkdownHtml: string;
};

@customElement('user-message')
export class UserMessage extends LitElement {
  static override styles = [
    designTokens,
    buttonStyles,
    // The only markdownStyles consumer that does not compose commonViewStyles,
    // so it is also the only one that would not inherit the shared focus ring.
    // A user message can contain \ref{}/\cref{}, which render as focusable
    // .latex-ref spans (role=button, tabindex=0) — they need the ring too.
    focusRingStyles,
    markdownStyles,
    css`
      :host {
        display: block;
      }

      .user-message-container {
        display: flex;
        justify-content: flex-end;
        margin: var(--wa-space-l) 0 var(--wa-space-m);
      }

      /* The log's own top padding already separates the first entry from the
         prelude panels; the inter-turn gap is only needed between entries. */
      :host(:first-child) .user-message-container {
        margin-top: 0;
      }

      .user-message {
        position: relative;
        padding: var(--wa-space-xs) var(--wa-space-s);
        max-width: min(78%, 38rem);
        background-color: var(--wa-color-neutral-fill-quiet);
        border: 0;
        border-radius: var(--wa-border-radius-xl, 20px);
        box-shadow: inset 0 0 0 1px
          color-mix(in srgb, var(--wa-color-surface-border) 72%, transparent);
      }

      .user-message-header {
        position: absolute;
        top: calc(100% + var(--wa-space-3xs));
        inset-inline-end: var(--wa-space-2xs);
        display: flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .user-message-header-left {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
      }

      .user-message-copy {
        opacity: 0;
        transition: opacity var(--transition-fast);
      }

      .user-message:hover .user-message-copy,
      .user-message:focus-within .user-message-copy {
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
        line-height: 1.55;
        font-size: var(--font-size);
      }

      .user-message--structured-delivery .user-message-content {
        max-height: min(45vh, 520px);
        overflow: auto;
        padding: var(--wa-space-xs);
        background: var(
          --wa-color-surface-lowered,
          var(--wa-color-surface-default)
        );
        border-radius: var(--wa-border-radius-m, var(--border-radius-small));
        font-size: var(--font-size-sm);
        line-height: 1.5;
        white-space: normal;
      }

      .user-message-timestamp {
        font-size: var(--font-size-xs);
      }

      @container (max-width: 520px) {
        .user-message {
          max-width: 88%;
        }
      }

      /*
       * High-contrast themes: the selection-background fill clashes with the
       * editor-foreground text (rendering the bubble unreadable) and the panel
       * border resolves to transparent. Fall back to the editor background plus
       * a solid contrast border so the message stays visible and delineated.
       * The bubble's outline is the inset box-shadow above, not a border, so
       * the contrast color has to replace that shadow: the base rule sets
       * border: 0, which zeroes border-style, so overriding border-color alone
       * painted nothing and this fallback never rendered.
       */
      :host-context(.vscode-high-contrast) .user-message,
      :host-context(.vscode-high-contrast-light) .user-message {
        background-color: var(--wa-color-surface-default);
        box-shadow: inset 0 0 0 1px
          var(--vscode-contrastBorder, var(--wa-color-surface-border));
      }
    `,
  ];

  /** Message text content */
  @property({ attribute: false }) text = '';

  /** Log ID for tracking */
  @property({ attribute: false }) logId = '';

  /** Message timestamp (Unix ms) */
  @property({ attribute: false }) timestamp = 0;

  /**
   * Typed workflow-delivery facts carried beside the text on the log row
   * (`UserMessagePayloadSchema`). When present, the bubble renders these —
   * the text is never re-parsed for structured data.
   */
  @property({ attribute: false })
  workflowSummary: WorkflowScriptDeliverySummary | null = null;

  private copyController = new CopyButtonController(this, {
    defaultTitle: 'Copy message',
  });

  private rawMessageCopyController = new CopyButtonController(this, {
    defaultTitle: 'Copy raw message',
  });

  private displayCache: DisplayState & {
    text: string;
    summary: WorkflowScriptDeliverySummary | null;
  } = {
    text: '',
    summary: null,
    isStructuredDelivery: false,
    hasRawMessage: false,
    displayText: '',
    copyText: '',
    structuredMarkdownHtml: '',
  };

  private getDisplayState(): DisplayState {
    if (
      this.displayCache.text === this.text &&
      this.displayCache.summary === this.workflowSummary
    ) {
      return this.displayCache;
    }

    const tag = deliveryTagOf(this.text);
    const isStructuredDelivery =
      tag !== undefined || this.workflowSummary !== null;
    const hasRawMessage = tag !== undefined && XML_ESCAPED_TAGS.has(tag);
    const displayText = hasRawMessage
      ? decodeXmlEntities(this.text)
      : this.text;
    // A workflow delivery renders its typed summary from the row's structured
    // field; the text is never mined for presentation metadata.
    const structuredDisplayText = this.workflowSummary
      ? formatWorkflowScriptDeliverySummary(this.workflowSummary)
      : displayText;

    this.displayCache = {
      text: this.text,
      summary: this.workflowSummary,
      isStructuredDelivery,
      hasRawMessage,
      displayText,
      copyText: structuredDisplayText,
      // Cached alongside displayText: message text is immutable after
      // creation, so the Markdown parse must not rerun on every render.
      structuredMarkdownHtml: isStructuredDelivery
        ? processMarkdownContent(structuredDisplayText)
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
      copyText,
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
              ${waIcon('comment', { className: 'user-message-icon' })}
              <span id="user-message-timestamp" class="user-message-timestamp"
                >${timeDisplay}</span
              >
              <wa-tooltip for="user-message-timestamp"
                >${tooltipTimestamp}</wa-tooltip
              >
            </span>
            ${renderIconActionButton({
              id: 'user-message-copy-button',
              icon: 'copy',
              label: copyState.ariaLabel,
              tooltip: copyState.title,
              className: `user-message-copy ${copyState.copied ? copyState.successClass : ''}`,
              onClick: () => this.copyController.copy(copyText),
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
