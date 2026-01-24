// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared schemas
import type {
  AgentProposalPrompt,
  BashApprovalPrompt,
  RetryRequestPrompt,
  ToolEditApprovalPrompt,
} from '@shared/schemas';

/**
 * Container for pending approval prompts.
 */
@customElement('prompt-container')
export class PromptContainer extends LitElement {
  @property({ type: Array })
  toolEditPrompts: ToolEditApprovalPrompt[] = [];

  @property({ type: Array })
  bashPrompts: BashApprovalPrompt[] = [];

  @property({ type: Array })
  retryPrompts: RetryRequestPrompt[] = [];

  @property({ type: Array })
  proposalPrompts: AgentProposalPrompt[] = [];

  protected createRenderRoot() {
    return this;
  }

  render() {
    const hasPrompts =
      this.toolEditPrompts.length ||
      this.bashPrompts.length ||
      this.retryPrompts.length ||
      this.proposalPrompts.length;

    if (!hasPrompts) {
      return html``;
    }

    return html`
      <div class="prompt-overlay">
        <div class="prompt-card">
          <h3>Pending approvals</h3>
          <div class="prompt-list">
            ${this.toolEditPrompts.map(
              (prompt) => html`
                <tool-edit-prompt .prompt=${prompt}></tool-edit-prompt>
              `,
            )}
            ${this.bashPrompts.map(
              (prompt) => html` <bash-prompt .prompt=${prompt}></bash-prompt> `,
            )}
            ${this.retryPrompts.map(
              (prompt) => html`
                <retry-prompt .prompt=${prompt}></retry-prompt>
              `,
            )}
            ${this.proposalPrompts.map(
              (prompt) => html`
                <agent-proposal .prompt=${prompt}></agent-proposal>
              `,
            )}
          </div>
        </div>
      </div>
    `;
  }
}
