// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - shared schemas
import type { RetryRequestPrompt } from '@shared/schemas';

// Local imports - common commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view context
import { commandsContext, type CommandsContextValue } from '../../context';

/**
 * Renders a retry request prompt.
 */
@customElement('retry-prompt')
export class RetryPrompt extends LitElement {
  @property({ type: Object })
  prompt!: RetryRequestPrompt;

  @consume({ context: commandsContext })
  private commands!: CommandsContextValue;

  protected createRenderRoot() {
    return this;
  }

  private handleRetry(): void {
    this.commands.postCommand(PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST, {
      stream: this.prompt.streamId,
    });
  }

  private handleDismiss(): void {
    this.commands.postCommand(PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST, {
      stream: this.prompt.streamId,
    });
  }

  render() {
    return html`
      <div class="panel">
        <strong>Retry request</strong>
        <div>${this.prompt.operation}</div>
        ${this.prompt.errorMessage
          ? html`<div>${this.prompt.errorMessage}</div>`
          : null}
        <div class="toolbar">
          <button class="secondary" @click=${this.handleRetry}>Retry</button>
          <button class="ghost" @click=${this.handleDismiss}>Dismiss</button>
        </div>
      </div>
    `;
  }
}
