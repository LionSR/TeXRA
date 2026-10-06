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
  formatScriptDeliverySummary,
} from '@shared/subagentFollowup';
import type { ScriptDeliverySummary } from '@shared/schemas';
import { DELIVERY_TAGS } from '@shared/deliveryTags';
import { CopyButtonController } from '@shared/litControllers/CopyButtonController';
import { designTokens } from '@ui/styles';
import { buttonStyles, focusRingStyles } from '@ui/styles/controlStyles';
import { markdownStyles } from '@ui/styles/markdownStyles';
import { panelFrameStyles } from '@ui/styles/surfaceStyles';
import { messageHeaderStyles } from '@ui/styles/messageHeaderStyles';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { TASK_ACTIONS } from '@ui/copy/nestedRuns';

// Local imports - formatter helpers
import { processMarkdownContent } from '../formatters/markdownRenderer';
import { formatDisplayTimestamp } from '../formatters/timestampUtils';

// Derived from the single owned DELIVERY_TAGS list (@shared/deliveryTags) so
// a new child-run kind only needs one entry there. See that module for the
// escaped-subset rationale.
const XML_ESCAPED_TAGS = new Set(
  DELIVERY_TAGS.filter((entry) => entry.escaped).map((entry) => entry.tag),
);

/** A user message's "Fork from here": the cut and the message, which the
 *  fork's composer holds. */
export interface ForkFromHere {
  readonly at: number;
  readonly draft: string;
}
const FORK_FROM_HERE = 'fork-from-here';

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
    messageHeaderStyles,
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
        /* One trailing gap. Leading space belongs to the transcript, so
           margins cannot double across a custom-element boundary. */
        margin: 0 0 var(--message-gap);
      }

      .user-message {
        ${panelFrameStyles}
        border-color: transparent;
        background: var(--wa-color-surface-raised);
        position: relative;
        width: 100%;
        padding: var(--panel-padding-block) var(--panel-padding-inline);
      }

      .user-message-header {
        margin-bottom: var(--wa-space-2xs);
      }

      /* Off while the conversation it sits in cannot fork now: the
         conversation sets the property, which crosses shadow roots. */
      .user-message-fork {
        display: var(--texra-fork-from-here, inline-flex);
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
        overflow-wrap: anywhere;
        unicode-bidi: plaintext;
        line-height: 1.55;
        font-size: var(--font-size-reading);
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

      /* Host contrast colors keep the message frame visible in both
         high-contrast themes. */
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

  /**
   * Typed workflow-delivery facts carried beside the text on the log row
   * (`UserMessagePayloadSchema`). When present, the bubble renders these —
   * the text is never re-parsed for structured data.
   */
  @property({ attribute: false })
  scriptSummary: ScriptDeliverySummary | null = null;

  /** Where "Fork from here" cuts (`UserRow.forkAt`); null offers none. The
   *  conversation that owns the row turns the event into its run's fork. */
  @property({ attribute: false }) forkAt: number | null = null;

  private copyController = new CopyButtonController(this, {
    defaultTitle: 'Copy message',
  });

  private rawMessageCopyController = new CopyButtonController(this, {
    defaultTitle: 'Copy raw message',
  });

  private displayCache: DisplayState & {
    text: string;
    summary: ScriptDeliverySummary | null;
  } = {
    text: '',
    summary: null,
    isStructuredDelivery: false,
    hasRawMessage: false,
    displayText: '',
    copyText: '',
    structuredMarkdownHtml: '',
  };

  private forkFromHere(): void {
    if (this.forkAt === null) return;
    this.dispatchEvent(
      new CustomEvent<ForkFromHere>(FORK_FROM_HERE, {
        detail: { at: this.forkAt, draft: this.text },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private getDisplayState(): DisplayState {
    if (
      this.displayCache.text === this.text &&
      this.displayCache.summary === this.scriptSummary
    ) {
      return this.displayCache;
    }

    const tag = deliveryTagOf(this.text);
    const isStructuredDelivery =
      tag !== undefined || this.scriptSummary !== null;
    const hasRawMessage = tag !== undefined && XML_ESCAPED_TAGS.has(tag);
    const displayText = hasRawMessage
      ? decodeXmlEntities(this.text)
      : this.text;
    // A workflow delivery renders its typed summary from the row's structured
    // field; the text is never mined for presentation metadata.
    const structuredDisplayText = this.scriptSummary
      ? formatScriptDeliverySummary(this.scriptSummary)
      : displayText;

    this.displayCache = {
      text: this.text,
      summary: this.scriptSummary,
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
    const messageDate = new Date(this.timestamp);
    const { timeDisplay, tooltipTimestamp } =
      formatDisplayTimestamp(messageDate);
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
        <article
          aria-label="User message"
          class=${classMap({
            'user-message': true,
            'user-message--structured-delivery': isStructuredDelivery,
          })}
        >
          <div class="user-message-header message-header">
            <span class="message-label"
              >${waIcon('user')}<span class="message-author">You</span></span
            >
            <time
              id="user-message-timestamp"
              class="user-message-timestamp message-timestamp"
              datetime=${messageDate.toISOString()}
              >${timeDisplay}</time
            >
            <wa-tooltip for="user-message-timestamp"
              >${tooltipTimestamp}</wa-tooltip
            >
            <span class="message-actions">
              ${renderIconActionButton({
                id: 'user-message-copy-button',
                icon: 'copy',
                label: copyState.ariaLabel,
                tooltip: copyState.title,
                className: `user-message-copy ${copyState.copied ? copyState.successClass : ''}`,
                onClick: () => this.copyController.copy(copyText),
              })}
              ${
                this.forkAt !== null && !isStructuredDelivery
                  ? renderIconActionButton({
                      id: 'user-message-fork-button',
                      icon: 'code-branch',
                      label: TASK_ACTIONS.forkFromHere,
                      tooltip: TASK_ACTIONS.forkFromHere,
                      className: 'user-message-copy user-message-fork',
                      onClick: () => this.forkFromHere(),
                    })
                  : nothing
              }
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
            </span>
          </div>
          ${
            isStructuredDelivery
              ? html`<div
                  class="user-message-content markdown-content"
                  data-log-id=${this.logId}
                  tabindex="0"
                  aria-label="User message details"
                >
                  ${unsafeHTML(structuredMarkdownHtml)}
                </div>`
              : html`<div
                  class="user-message-content"
                  data-log-id=${this.logId}
                  .textContent=${displayText}
                ></div>`
          }
        </article>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementEventMap {
    'fork-from-here': CustomEvent<ForkFromHere>;
  }
  interface HTMLElementTagNameMap {
    'user-message': UserMessage;
  }
}
