// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - shared schemas
import type { AgentProposalPrompt } from '@shared/schemas';

// Local imports - common commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view context
import { commandsContext, type CommandsContextValue } from '../../context';

/**
 * Renders an agent proposal prompt.
 */
@customElement('agent-proposal')
export class AgentProposal extends LitElement {
  @property({ type: Object })
  prompt!: AgentProposalPrompt;

  @consume({ context: commandsContext })
  private commands!: CommandsContextValue;

  protected createRenderRoot() {
    return this;
  }

  private handleAction(action: 'approve' | 'setup' | 'reject'): void {
    this.commands.postCommand(PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION, {
      proposalId: this.prompt.proposalId,
      action,
    });
  }

  render() {
    return html`
      <div class="panel">
        <strong>Agent proposal</strong>
        <div>${this.prompt.agent}</div>
        <div class="toolbar">
          <button
            class="secondary"
            @click=${() => this.handleAction('approve')}
          >
            Approve
          </button>
          <button class="ghost" @click=${() => this.handleAction('setup')}>
            Setup
          </button>
          <button class="ghost" @click=${() => this.handleAction('reject')}>
            Reject
          </button>
        </div>
      </div>
    `;
  }
}
