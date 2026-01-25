// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

@customElement('queued-follow-ups')
export class QueuedFollowUps extends LitElement {
  @property({ type: Array }) messages: string[] = [];

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult {
    const visible = this.messages.length > 0;
    return html`
      <vscode-collapsible
        id=${ELEMENT_IDS.QUEUED_FOLLOW_UPS_COLLAPSIBLE}
        class="queued-follow-ups-collapsible progress-collapsible"
        title="Queued follow-ups"
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
            (message) => html`
              <div class="queued-follow-up-item">
                <i class="codicon codicon-comment queued-follow-up-icon"></i>
                <span class="queued-follow-up-text">${message}</span>
              </div>
            `,
          )}
        </div>
      </vscode-collapsible>
    `;
  }
}
