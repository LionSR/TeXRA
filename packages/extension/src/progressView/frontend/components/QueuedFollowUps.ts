// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/details/details.js';

const MAX_MESSAGE_LENGTH = 200;

@customElement('queued-follow-ups')
export class QueuedFollowUps extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
        max-width: 100%;
        min-width: 0;
      }

      /* Info-style collapsible for queued messages */
      .queued-collapsible {
        border: var(--border-thin) solid var(--wa-color-brand-border-quiet);
        border-radius: var(--border-radius);
        background-color: var(--wa-color-brand-fill-quiet);
      }

      .queued-collapsible::part(header) {
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        font-weight: var(--font-weight-medium);
        background-color: transparent;
      }

      .queued-collapsible::part(content) {
        padding: 0 var(--wa-space-2xs) var(--wa-space-2xs);
      }

      .queued-follow-ups-list {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-3xs);
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .queued-follow-up-item {
        display: flex;
        align-items: flex-start;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        font-size: var(--font-size);
        line-height: var(--line-height-normal);
        background-color: var(--wa-color-surface-default);
        border-radius: var(--border-radius-small);
        border: var(--border-thin) solid var(--color-border);
        min-width: 0;
      }

      .queued-follow-up-icon {
        flex-shrink: 0;
        font-size: var(--font-size-icon-sm);
        line-height: var(--line-height-normal);
        margin-top: var(--border-thin);
        color: var(--wa-color-brand-border-quiet);
      }

      .queued-follow-up-text {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
        text-align: start;
        color: var(--wa-color-text-normal);
      }
    `,
  ];

  @property({ attribute: false }) messages: string[] = [];

  private truncateMessage(message: string): {
    display: string;
    full: string | undefined;
  } {
    if (message.length <= MAX_MESSAGE_LENGTH) {
      return { display: message, full: undefined };
    }
    const display = truncateWithEllipsis(message, MAX_MESSAGE_LENGTH);
    return {
      display,
      // The cheap length guard above counts UTF-16 code units, while the
      // shared truncator counts graphemes. Do not add a redundant tooltip or
      // tab stop when emoji or combining marks made the guard conservative.
      full: display === message ? undefined : message,
    };
  }

  override render(): TemplateResult | typeof nothing {
    // Empty queue renders nothing. The layout fix lives in FollowUpInput,
    // which only mounts this element when messages exist — Lit's `nothing`
    // clears shadow content but the host stays in the parent's layout, so a
    // mounted-but-empty host would still consume the parent's flex gap.
    if (this.messages.length === 0) return nothing;
    const messageCount = this.messages.length;
    const summary = `${messageCount === 1 ? 'Queued message' : 'Queued messages'} (${messageCount})`;
    return html`
      <wa-details
        id=${ELEMENT_IDS.QUEUED_FOLLOW_UPS_COLLAPSIBLE}
        class="queued-collapsible"
        summary=${summary}
        open
      >
        <ol
          id=${ELEMENT_IDS.QUEUED_FOLLOW_UPS_LIST}
          class="queued-follow-ups-list"
          aria-label="Queued messages"
        >
          ${repeat(
            this.messages,
            (_message, index) => index,
            (message, index) => {
              const { display, full } = this.truncateMessage(message);
              const itemId = `queued-follow-up-${index}`;
              return html`
                <li
                  id=${itemId}
                  class="queued-follow-up-item"
                  tabindex=${full ? '0' : nothing}
                >
                  ${waIcon('comment', { className: 'queued-follow-up-icon' })}
                  <bdi class="queued-follow-up-text">${display}</bdi>
                </li>
                ${
                  full
                    ? html`<wa-tooltip for=${itemId} dir="auto"
                        >${full}</wa-tooltip
                      >`
                    : nothing
                }
              `;
            },
          )}
        </ol>
      </wa-details>
    `;
  }
}
