/**
 * UserMessage component for displaying user input messages.
 *
 * Renders a message disclosure with persistent timestamp and copy actions.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/details/details.js';

// Local imports - shared styles
import { CopyButtonController } from '@ui/litControllers/CopyButtonController';
import { designTokens } from '@ui/styles';
import { buttonStyles, focusRingStyles } from '@ui/styles/controlStyles';
import { markdownStyles } from '@ui/styles/markdownStyles';
import { panelFrameStyles } from '@ui/styles/surfaceStyles';
import {
  messageHeaderStyles,
  messageDisclosureStyles,
} from '@ui/styles/messageHeaderStyles';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { TASK_ACTIONS } from '@ui/copy/nestedRuns';

// Local imports - formatter helpers
import { processMarkdownContent } from '../formatters/markdownRenderer';
import { formatDisplayTimestamp } from '../formatters/timestampUtils';
import type {
  ScriptDeliverySummary,
  StoredMediaSchema,
} from '@texra-ai/harness/schemas';

/** A user message's "Fork from here": the cut and the message with the
 *  media it attached, which the fork's composer holds. */
export interface ForkFromHere {
  readonly at: number;
  readonly draft: string;
  readonly media: readonly (typeof StoredMediaSchema.Type)[];
}
const FORK_FROM_HERE = 'fork-from-here';

@customElement('user-message')
export class UserMessage extends LitElement {
  static override styles = [
    designTokens,
    buttonStyles,
    messageHeaderStyles,
    messageDisclosureStyles,
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
        width: 100%;
      }

      .user-message::part(base) {
        ${panelFrameStyles}
        border-color: transparent;
        background: var(--wa-color-surface-raised);
      }

      /* Off while the conversation it sits in cannot fork now: the
         conversation sets the property, which crosses shadow roots. */
      .user-message-fork {
        display: var(--texra-fork-from-here, inline-flex);
      }

      .user-message-copy {
        opacity: 1;
      }

      .user-message-copy.copy-success {
        opacity: 1;
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
      :host-context(.vscode-high-contrast) .user-message::part(base),
      :host-context(.vscode-high-contrast-light) .user-message::part(base) {
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
   * (`UserMessagePayloadSchema`). When present, the text is the delivery's
   * summary and the bubble renders it as Markdown.
   */
  @property({ attribute: false })
  scriptSummary: ScriptDeliverySummary | null = null;

  /** Where "Fork from here" cuts (`UserRow.forkAt`); null offers none. The
   *  conversation that owns the row turns the event into its run's fork. */
  @property({ attribute: false }) forkAt: number | null = null;

  /** The media the message attached (`UserRow.media`), which "Fork from
   *  here" carries with its text. */
  @property({ attribute: false })
  media: readonly (typeof StoredMediaSchema.Type)[] = [];

  private copyController = new CopyButtonController(this, {
    defaultTitle: 'Copy message',
  });

  /** A delivery's rendered Markdown, by its text: message text is immutable
   *  after creation, so the parse must not rerun on every render. */
  private markdownCache = { text: '', html: '' };

  private forkFromHere(): void {
    if (this.forkAt === null) return;
    this.dispatchEvent(
      new CustomEvent<ForkFromHere>(FORK_FROM_HERE, {
        detail: {
          at: this.forkAt,
          draft: this.text,
          media: this.media,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private markdownHtml(): string {
    if (this.markdownCache.text !== this.text) {
      this.markdownCache = {
        text: this.text,
        html: processMarkdownContent(this.text),
      };
    }
    return this.markdownCache.html;
  }

  override render(): TemplateResult {
    const messageDate = new Date(this.timestamp);
    const { timeDisplay, tooltipTimestamp } = formatDisplayTimestamp(
      messageDate,
      'minute',
    );
    const copyState = this.copyController.state;
    const isStructuredDelivery = this.scriptSummary !== null;

    return html`
      <div class="user-message-container">
        <wa-details
          appearance="plain"
          icon-placement="end"
          open
          aria-label="User message"
          class=${classMap({
            'user-message': true,
            'message-disclosure': true,
            'user-message--structured-delivery': isStructuredDelivery,
          })}
        >
          <div slot="summary" class="user-message-header message-header">
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
            <span
              class="message-actions"
              @click=${(event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              @keydown=${(event: KeyboardEvent) => event.stopPropagation()}
            >
              ${renderLabeledActionButton({
                id: 'user-message-copy-button',
                text: copyState.copied ? 'Copied' : 'Copy',
                label: copyState.ariaLabel,
                tooltip: copyState.title,
                className: `user-message-copy message-copy ${copyState.copied ? copyState.successClass : ''}`,
                onClick: () => this.copyController.copy(this.text),
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
                  ${
                    // processMarkdownContent uses MarkdownIt with html:false
                    // and escapes restored LaTeX reference labels.
                    unsafeHTML(this.markdownHtml())
                  }
                </div>`
              : html`<div
                  class="user-message-content"
                  data-log-id=${this.logId}
                  .textContent=${this.text}
                ></div>`
          }
        </wa-details>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'user-message': UserMessage;
  }
}
