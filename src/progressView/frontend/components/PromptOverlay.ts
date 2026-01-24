// Third-party imports
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports
import type {
  AgentProposalPrompt,
  BashApprovalPrompt,
  RetryRequestPrompt,
  ToolEditApprovalPrompt,
} from '@shared/schemas';

export type PromptState =
  | { kind: 'toolEdit'; data: ToolEditApprovalPrompt }
  | { kind: 'bash'; data: BashApprovalPrompt }
  | { kind: 'retry'; data: RetryRequestPrompt }
  | { kind: 'proposal'; data: AgentProposalPrompt };

@customElement('prompt-overlay')
export class PromptOverlay extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      background: color-mix(
        in srgb,
        var(--vscode-editor-background) 60%,
        transparent
      );
    }

    :host([hidden]) {
      display: none;
    }

    .prompt-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 16px;
      max-width: 600px;
      width: min(92vw, 600px);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
    }

    .prompt-header {
      font-weight: 600;
      margin-bottom: 8px;
    }

    .prompt-body {
      font-size: 13px;
      line-height: 1.5;
    }

    .prompt-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 16px;
      justify-content: flex-end;
    }

    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      padding: 6px 10px;
      cursor: pointer;
    }

    button.secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, inherit);
    }
  `;

  @property({ type: Object }) prompt: PromptState | null = null;

  render() {
    if (!this.prompt) {
      return html``;
    }

    return html` <div class="prompt-card">${this.renderPrompt()}</div> `;
  }

  private renderPrompt() {
    switch (this.prompt?.kind) {
      case 'toolEdit':
        return this.renderToolEdit(this.prompt.data);
      case 'bash':
        return this.renderBash(this.prompt.data);
      case 'retry':
        return this.renderRetry(this.prompt.data);
      case 'proposal':
        return this.renderProposal(this.prompt.data);
      default:
        return html``;
    }
  }

  private renderToolEdit(prompt: ToolEditApprovalPrompt) {
    return html`
      <div class="prompt-header">Tool edit approval</div>
      <div class="prompt-body">
        <p><strong>File:</strong> ${prompt.relativePath || prompt.path}</p>
        <p>
          <strong>Changes:</strong> +${prompt.addedLines} /
          -${prompt.removedLines}
        </p>
        <p><strong>Tool:</strong> ${prompt.sourceTool}</p>
      </div>
      <div class="prompt-actions">
        <button class="secondary" @click=${() => this.emitAction('openDiff')}>
          Open diff
        </button>
        <button
          class="secondary"
          @click=${() => this.emitAction('previewProposed')}
        >
          Preview
        </button>
        <button
          class="secondary"
          @click=${() => this.emitAction('showLatexdiff')}
        >
          LaTeXdiff
        </button>
        <button class="secondary" @click=${() => this.emitAction('reject')}>
          Reject
        </button>
        <button @click=${() => this.emitAction('approve')}>Approve</button>
      </div>
    `;
  }

  private renderBash(prompt: BashApprovalPrompt) {
    return html`
      <div class="prompt-header">Command approval</div>
      <div class="prompt-body">
        <p><strong>Command:</strong> ${prompt.command}</p>
      </div>
      <div class="prompt-actions">
        <button class="secondary" @click=${() => this.emitAction('reject')}>
          Reject
        </button>
        <button @click=${() => this.emitAction('approve')}>Approve</button>
      </div>
    `;
  }

  private renderRetry(prompt: RetryRequestPrompt) {
    return html`
      <div class="prompt-header">Retry request</div>
      <div class="prompt-body">
        <p><strong>Operation:</strong> ${prompt.operation}</p>
        ${prompt.errorMessage
          ? html`<p><strong>Error:</strong> ${prompt.errorMessage}</p>`
          : html``}
      </div>
      <div class="prompt-actions">
        <button class="secondary" @click=${() => this.emitAction('cancel')}>
          Cancel
        </button>
        <button @click=${() => this.emitAction('retry')}>Retry</button>
      </div>
    `;
  }

  private renderProposal(prompt: AgentProposalPrompt) {
    return html`
      <div class="prompt-header">Agent proposal</div>
      <div class="prompt-body">
        <p><strong>Agent:</strong> ${prompt.agent}</p>
        <p><strong>Model:</strong> ${prompt.model}</p>
        <p><strong>Instruction:</strong> ${prompt.instruction}</p>
      </div>
      <div class="prompt-actions">
        <button class="secondary" @click=${() => this.emitAction('reject')}>
          Reject
        </button>
        <button class="secondary" @click=${() => this.emitAction('setup')}>
          Setup
        </button>
        <button @click=${() => this.emitAction('approve')}>Approve</button>
      </div>
    `;
  }

  private emitAction(action: string) {
    if (!this.prompt) return;
    this.dispatchEvent(
      new CustomEvent('prompt-action', {
        detail: { prompt: this.prompt, action },
        bubbles: true,
        composed: true,
      }),
    );
  }
}
