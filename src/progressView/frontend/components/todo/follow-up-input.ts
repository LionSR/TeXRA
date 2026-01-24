// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - common commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view context
import { commandsContext, type CommandsContextValue } from '../../context';

/**
 * Input area for sending follow-up messages.
 */
@customElement('follow-up-input')
export class FollowUpInput extends LitElement {
  @property({ type: String })
  streamId: string | null = null;

  @consume({ context: commandsContext })
  private commands!: CommandsContextValue;

  @query('textarea')
  private textarea?: HTMLTextAreaElement;

  protected createRenderRoot() {
    return this;
  }

  private handleSend(): void {
    this.sendMessage(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP);
  }

  private handlePolish(): void {
    this.sendMessage(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP);
  }

  private sendMessage(command: string): void {
    if (!this.streamId || !this.textarea) return;
    const text = this.textarea.value.trim();
    if (!text) return;
    this.commands.postCommand(command, { stream: this.streamId, text });
    this.textarea.value = '';
  }

  render() {
    return html`
      <textarea placeholder="Send a follow-up..."></textarea>
      <div class="toolbar">
        <button class="secondary" @click=${this.handleSend}>Send</button>
        <button class="ghost" @click=${this.handlePolish}>Polish</button>
      </div>
    `;
  }
}
