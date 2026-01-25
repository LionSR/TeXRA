// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

const MAX_MESSAGE_LENGTH = 200;

@customElement('queued-follow-ups')
export class QueuedFollowUps extends LitElement {
  @property({ type: Array }) messages: string[] = [];

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  private get collapsibleTitle(): string {
    const count = this.messages.length;
    if (count === 0) return 'Queued follow-ups';
    if (count === 1) return 'Queued follow-up (1 pending)';
    return `Queued follow-ups (${count} pending)`;
  }

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
        title=${this.collapsibleTitle}
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
                <div class="queued-follow-up-item" title=${full ?? ''}>
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
