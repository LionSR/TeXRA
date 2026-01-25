// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared
import type {
  AgentProposalPrompt,
  BashApprovalPrompt,
  RetryRequestPrompt,
  ToolEditApprovalPrompt,
  WorkflowAgentProposalPrompt,
} from '@shared/schemas';
import { AGENT_CATEGORY } from '@shared/schemas';
import { getBasename } from '@shared/utils/path';
import { postMessage } from '@shared/vscode';

// Local imports - webview commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view
import { ProgressEvents } from '../events';

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

    .file-list {
      margin: 4px 0;
    }

    .file-list-label {
      color: var(--vscode-descriptionForeground);
      margin-right: 4px;
    }

    .file-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }

    .file-link:hover {
      text-decoration: underline;
    }
  `;

  @property({ type: Object }) prompt: PromptState | null = null;

  render(): TemplateResult {
    if (!this.prompt) {
      return html``;
    }

    return html`<div class="prompt-card">${this.renderPrompt()}</div>`;
  }

  private renderPrompt(): TemplateResult {
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

  private renderToolEdit(prompt: ToolEditApprovalPrompt): TemplateResult {
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

  private renderBash(prompt: BashApprovalPrompt): TemplateResult {
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

  private renderRetry(prompt: RetryRequestPrompt): TemplateResult {
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

  private renderProposal(prompt: AgentProposalPrompt): TemplateResult {
    const isWorkflow = prompt.agentCategory === AGENT_CATEGORY.WORKFLOW;
    const categoryLabel = isWorkflow ? 'Workflow' : 'Tool-Use';

    return html`
      <div class="prompt-header">Agent proposal (${categoryLabel})</div>
      <div class="prompt-body">
        <p><strong>Agent:</strong> ${prompt.agent}</p>
        <p><strong>Model:</strong> ${prompt.model}</p>
        <p><strong>Instruction:</strong> ${prompt.instruction}</p>
        ${isWorkflow ? this.renderWorkflowFiles(prompt) : nothing}
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

  private renderWorkflowFiles(prompt: WorkflowAgentProposalPrompt): TemplateResult {
    const combine = (single: string | null | undefined, arr: string[] = []) =>
      [single, ...arr].filter((f): f is string => Boolean(f));

    const inputFiles = combine(prompt.inputFile, prompt.inputFiles);
    const referenceFiles = combine(prompt.referenceFile, prompt.referenceFiles);
    const auxiliaryFiles = combine(prompt.auxiliaryFile, prompt.auxiliaryFiles);
    const mediaFiles = combine(prompt.mediaFile, prompt.mediaFiles);
    const outputFiles = prompt.outputFiles ?? [];

    return html`
      ${this.renderFileList('Input', inputFiles)}
      ${this.renderFileList('Reference', referenceFiles)}
      ${this.renderFileList('Auxiliary', auxiliaryFiles)}
      ${this.renderFileList('Media', mediaFiles)}
      ${this.renderFileList('Output', outputFiles)}
    `;
  }

  private renderFileList(
    label: string,
    files: string[],
  ): TemplateResult | typeof nothing {
    if (files.length === 0) return nothing;

    return html`
      <div class="file-list">
        <span class="file-list-label">${label}:</span>
        ${files.map(
          (file, i) => html`${i > 0 ? ', ' : ''}<span
              class="file-link"
              title=${file}
              @click=${() => this.openFile(file)}
              >${getBasename(file)}</span
            >`,
        )}
      </div>
    `;
  }

  private openFile(filePath: string): void {
    postMessage(PROGRESS_VIEW_COMMANDS.OPEN_FILE, { file: filePath });
  }

  private emitAction(action: string) {
    if (!this.prompt) return;
    this.dispatchEvent(
      ProgressEvents.promptAction({ prompt: this.prompt, action }),
    );
  }
}
