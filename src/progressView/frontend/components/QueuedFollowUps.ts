// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
// Note: Design tokens from tokens.css are inherited into Shadow DOM via :root
import { codiconIconClasses } from '@shared/styles/codiconStyles';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

const MAX_MESSAGE_LENGTH = 200;

@customElement('queued-follow-ups')
export class QueuedFollowUps extends LitElement {
  static styles = [
    codiconIconClasses,
    css`
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      .queued-follow-ups-collapsible {
        border-radius: var(--border-radius);
        background-color: var(--vscode-inputValidation-infoBackground);
        border: var(--border-thin) solid
          var(--vscode-inputValidation-infoBorder);
      }

      .queued-follow-ups-collapsible::part(header) {
        font-weight: 500;
        background-color: transparent;
      }

      .queued-follow-ups-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-tiny);
      }

      .queued-follow-up-item {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-small);
        padding: var(--spacing-tiny) var(--spacing-small);
        font-size: var(--font-size);
        line-height: 1.4;
        background-color: var(--vscode-editor-background);
        border-radius: var(--border-radius-small);
        border: var(--border-thin) solid var(--color-border);
      }

      .queued-follow-up-icon {
        flex-shrink: 0;
        font-size: var(--font-size-icon-sm);
        line-height: 1.4;
        margin-top: var(--border-thin);
        color: var(--vscode-inputValidation-infoBorder);
      }

      .queued-follow-up-text {
        flex: 1;
        word-break: break-word;
        white-space: pre-wrap;
        color: var(--vscode-foreground);
      }
    `,
  ];

  @property({ type: Array }) messages: string[] = [];

  private truncateMessage(message: string): {
    display: string;
    full: string | null;
  } {
    if (message.length <= MAX_MESSAGE_LENGTH) {
      return { display: message, full: null };
    }
    return {
      display: message.substring(0, MAX_MESSAGE_LENGTH) + '...',
      full: message,
    };
  }

  render(): TemplateResult {
    const visible = this.messages.length > 0;
    return html`
      <vscode-collapsible
        id=${ELEMENT_IDS.QUEUED_FOLLOW_UPS_COLLAPSIBLE}
        class="queued-follow-ups-collapsible progress-collapsible"
        title="Queued Messages"
        ?open=${visible}
        ?hidden=${!visible}
        aria-hidden=${visible ? 'false' : 'true'}
      >
        <div
          id=${ELEMENT_IDS.QUEUED_FOLLOW_UPS_LIST}
          class="queued-follow-ups-list"
        >
          ${repeat(
            this.messages,
            (message, index) => `${index}-${message.slice(0, 20)}`,
            (message) => {
              const { display, full } = this.truncateMessage(message);
              return html`
                <div
                  class="queued-follow-up-item"
                  title=${ifDefined(full ?? undefined)}
                >
                  <i class="codicon codicon-comment queued-follow-up-icon"></i>
                  <span class="queued-follow-up-text">${display}</span>
                </div>
              `;
            },
          )}
        </div>
      </vscode-collapsible>
    `;
  }
}
