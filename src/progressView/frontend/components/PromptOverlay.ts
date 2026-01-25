// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

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

    .feedback-section {
      margin-top: 12px;
    }

    .feedback-section textarea {
      width: 100%;
      min-height: 60px;
      padding: 8px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-family: inherit;
      font-size: 13px;
      resize: vertical;
    }

    .feedback-section textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }

    .feedback-label {
      display: block;
      margin-bottom: 4px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
  `;

  @property({ type: Object }) prompt: PromptState | null = null;
  @state() private showFeedback = false;
  @query('.feedback-input') private feedbackInput?: HTMLTextAreaElement;

  // Reset feedback state when prompt changes
  protected willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('prompt')) {
      this.showFeedback = false;
    }
  }

  render(): TemplateResult | typeof nothing {
    if (!this.prompt) {
      return nothing;
    }

    return html`<div class="prompt-card">${this.renderPrompt()}</div>`;
  }

  private renderPrompt(): TemplateResult | typeof nothing {
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
        return nothing;
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
        ${when(
          prompt.errorMessage,
          () => html`<p><strong>Error:</strong> ${prompt.errorMessage}</p>`,
        )}
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
        ${when(
          this.showFeedback,
          () => html`
            <div class="feedback-section">
              <label class="feedback-label"
                >Rejection feedback (optional):</label
              >
              <textarea
                class="feedback-input"
                placeholder="Why are you rejecting this proposal?"
              ></textarea>
            </div>
          `,
        )}
      </div>
      <div class="prompt-actions">
        <button class="secondary" @click=${this.handleRejectClick}>
          ${this.showFeedback ? 'Submit' : 'Reject'}
        </button>
        <button class="secondary" @click=${() => this.emitAction('setup')}>
          Setup
        </button>
        <button @click=${() => this.emitAction('approve')}>Approve</button>
      </div>
    `;
  }

  private handleRejectClick(): void {
    if (this.prompt?.kind !== 'proposal') {
      this.emitAction('reject');
      return;
    }

    if (!this.showFeedback) {
      // First click: show feedback form
      this.showFeedback = true;
      // Focus textarea after render
      this.updateComplete.then(() => {
        this.feedbackInput?.focus();
      });
      return;
    }

    // Second click: submit with feedback
    const feedback = this.feedbackInput?.value?.trim() || undefined;
    this.emitAction('reject', feedback);
    this.showFeedback = false;
  }

  private renderWorkflowFiles(
    prompt: WorkflowAgentProposalPrompt,
  ): TemplateResult {
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
          (file, i) =>
            html`${i > 0 ? ', ' : ''}<span
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

  private emitAction(action: string, feedback?: string) {
    if (!this.prompt) return;
    this.dispatchEvent(
      ProgressEvents.promptAction({ prompt: this.prompt, action, feedback }),
    );
  }
}
