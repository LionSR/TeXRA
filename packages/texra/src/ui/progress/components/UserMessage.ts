/**
 * UserMessage component for displaying user input messages.
 *
 * Renders the message as a bubble at the trailing edge, with its time and
 * its copy and fork actions on the line under it.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles
import './CopyButton';
import { designTokens } from '@ui/styles';
import { buttonStyles, focusRingStyles } from '@ui/styles/controlStyles';
import { markdownStyles } from '@ui/styles/markdownStyles';
import {
  messageHeaderStyles,
  messageMetaStyles,
} from '@ui/styles/messageHeaderStyles';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@ui/wa/actionButtons';
import { TASK_ACTIONS } from '@ui/copy/nestedRuns';

// Local imports - formatter helpers
import { renderMarkdownHtml } from '../formatters/markdownRenderer';
import { formatDisplayTimestamp } from '../formatters/timestampUtils';
import type {
  ScriptDeliverySummary,
  StoredMediaSchema,
} from '@texra-ai/worldline/schemas';

/** A user message's "Fork from here": the cut and the message with the
 *  media it attached, which the fork's composer holds. */
export interface ForkFromHere {
  readonly at: number;
  readonly draft: string;
  readonly media: readonly (typeof StoredMediaSchema.Type)[];
}
const FORK_FROM_HERE = 'fork-from-here';

/** A message long enough that the transcript shows its first lines only. */
const isLong = (text: string): boolean =>
  text.length > 600 || text.split('\n', 9).length > 8;

@customElement('user-message')
export class UserMessage extends LitElement {
  static override styles = [
    designTokens,
    buttonStyles,
    messageHeaderStyles,
    messageMetaStyles,
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

      /* A person's message is a bubble at the trailing edge, so the two
         sides of the conversation differ by position and no author line is
         needed. The line under it is its trailing gap. */
      .user-message {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
      }

      .user-message-bubble {
        box-sizing: border-box;
        min-width: 0;
        max-width: 80%;
        padding: var(--panel-padding-block) var(--panel-padding-inline);
        border: var(--border-thin) solid transparent;
        border-radius: var(--panel-radius);
        background: var(--wa-color-surface-raised);
      }

      /* Off while the conversation it sits in cannot fork now: the
         conversation sets the property, which crosses shadow roots. */
      .user-message-fork {
        display: var(--texra-fork-from-here, inline-flex);
      }

      .user-message-content {
        color: var(--wa-color-text-normal);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        unicode-bidi: plaintext;
        line-height: 1.55;
        font-size: var(--font-size-reading);
      }

      /* A long message shows its first lines, fading out, until opened. */
      .user-message-content.is-folded {
        max-height: 11lh;
        overflow: hidden;
        mask-image: linear-gradient(to bottom, #000 calc(100% - 2lh), #0000);
      }

      /* A script's delivery is a document, not a line of chat: full width. */
      .user-message--structured-delivery > .user-message-bubble {
        width: 100%;
        max-width: none;
      }

      .user-message--structured-delivery .user-message-content {
        max-height: min(45vh, 520px);
        overflow: auto;
        font-size: var(--font-size-sm);
        line-height: var(--line-height-normal);
        white-space: normal;
      }

      /* Host contrast colors keep the bubble visible in both
         high-contrast themes. */
      :host-context(.vscode-high-contrast) .user-message-bubble,
      :host-context(.vscode-high-contrast-light) .user-message-bubble {
        background-color: var(--wa-color-surface-default);
        border-color: var(--vscode-contrastBorder, var(--color-border));
      }
    `,
  ];

  /** Message text content */
  @property({ attribute: false }) text = '';

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

  /** Whether a long message shows all of its text. */
  @state() private expanded = false;

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
        html: renderMarkdownHtml(this.text),
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
    const isStructuredDelivery = this.scriptSummary !== null;

    const folds = !isStructuredDelivery && isLong(this.text);
    const folded = folds && !this.expanded;

    return html`
      <div
        class=${classMap({
          'user-message': true,
          'user-message--structured-delivery': isStructuredDelivery,
        })}
      >
        <div class="user-message-bubble" role="group" aria-label="User message">
          ${
            isStructuredDelivery
              ? html`<div
                  class="user-message-content markdown-content"
                  tabindex="0"
                  aria-label="User message details"
                >
                  ${
                    // renderMarkdownHtml uses MarkdownIt with html:false
                    // and escapes restored LaTeX reference labels.
                    unsafeHTML(this.markdownHtml())
                  }
                </div>`
              : html`<div
                  class=${classMap({
                    'user-message-content': true,
                    'is-folded': folded,
                  })}
                  .textContent=${this.text}
                ></div>`
          }
          ${
            folds
              ? renderLabeledActionButton({
                  text: folded ? 'Show full message' : 'Show less',
                  kind: 'link',
                  onClick: () => {
                    this.expanded = !this.expanded;
                  },
                })
              : nothing
          }
        </div>
        <div class="message-meta">
          <time
            class="message-timestamp"
            datetime=${messageDate.toISOString()}
            title=${tooltipTimestamp}
            >${timeDisplay}</time
          >
          <copy-button
            .text=${this.text}
            .label=${'Copy message'}
          ></copy-button>
          ${
            this.forkAt !== null && !isStructuredDelivery
              ? renderIconActionButton({
                  id: 'user-message-fork-button',
                  icon: 'code-branch',
                  label: TASK_ACTIONS.forkFromHere,
                  tooltip: TASK_ACTIONS.forkFromHere,
                  className: 'user-message-fork',
                  onClick: () => this.forkFromHere(),
                })
              : nothing
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
