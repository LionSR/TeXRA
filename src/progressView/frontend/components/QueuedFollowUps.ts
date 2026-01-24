// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('queued-follow-ups')
export class QueuedFollowUps extends LitElement {
  @property({ type: Array }) messages: string[] = [];
  @property({ type: Boolean }) visible = false;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override render() {
    const shouldShow = this.visible && this.messages.length > 0;
    if (!shouldShow) {
      return html`
        <vscode-collapsible
          id="queuedFollowUpsCollapsible"
          class="queued-follow-ups-collapsible"
          title="Queued Message"
          hidden
        ></vscode-collapsible>
      `;
    }

    const combinedText = this.messages.join('\n\n');
    const displayText =
      combinedText.length > 200
        ? `${combinedText.substring(0, 200)}...`
        : combinedText;
    const count = this.messages.length;
    const suffix = count === 1 ? '' : ` (${count} pending)`;

    return html`
      <vscode-collapsible
        id="queuedFollowUpsCollapsible"
        class="queued-follow-ups-collapsible"
        title=${`Queued Message${suffix}`}
      >
        <div class="queued-follow-ups-list" id="queuedFollowUpsList">
          <div class="queued-follow-up-item">
            <i class="codicon codicon-comment queued-follow-up-icon"></i>
            <span class="queued-follow-up-text" title=${combinedText}
              >${displayText}</span
            >
          </div>
        </div>
      </vscode-collapsible>
    `;
  }
}
