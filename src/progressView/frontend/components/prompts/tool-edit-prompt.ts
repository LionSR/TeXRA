// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - shared schemas
import type { ToolEditApprovalPrompt } from '@shared/schemas';

// Local imports - common commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view context
import { commandsContext, type CommandsContextValue } from '../../context';

/**
 * Renders a tool edit approval prompt.
 */
@customElement('tool-edit-prompt')
export class ToolEditPrompt extends LitElement {
  @property({ type: Object })
  prompt!: ToolEditApprovalPrompt;

  @consume({ context: commandsContext })
  private commands!: CommandsContextValue;

  protected createRenderRoot() {
    return this;
  }

  private handleAction(action: 'approve' | 'reject'): void {
    this.commands.postCommand(
      PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
      {
        requestId: this.prompt.requestId,
        action,
      },
    );
  }

  render() {
    return html`
      <div class="panel">
        <strong>Tool edit</strong>
        <div>${this.prompt.relativePath}</div>
        <div>+${this.prompt.addedLines} / -${this.prompt.removedLines}</div>
        <div class="toolbar">
          <button
            class="secondary"
            @click=${() => this.handleAction('approve')}
          >
            Approve
          </button>
          <button class="ghost" @click=${() => this.handleAction('reject')}>
            Reject
          </button>
        </div>
      </div>
    `;
  }
}
