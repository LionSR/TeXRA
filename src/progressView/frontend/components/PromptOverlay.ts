// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared
import { AGENT_CATEGORY } from '@shared/schemas';
import { getBasename } from '@shared/utils/path';
import { postMessage } from '@shared/vscode';
import { designTokens } from '@shared/styles/litStyles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';

// Local imports - webview commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view
import { ProgressEvents } from '../events';
import type {
  AgentProposalPrompt,
  BashApprovalPrompt,
  RetryRequestPrompt,
  ToolEditApprovalPrompt,
  WorkflowAgentProposalPrompt,
} from '@shared/schemas';

// =============================================================================
// Types
// =============================================================================

export type PromptState =
  | { kind: 'toolEdit'; data: ToolEditApprovalPrompt }
  | { kind: 'bash'; data: BashApprovalPrompt }
  | { kind: 'retry'; data: RetryRequestPrompt }
  | { kind: 'proposal'; data: AgentProposalPrompt };

/** Action button configuration */
type ActionConfig = {
  action: string;
  label: string;
  icon: string;
  variant: 'approve' | 'reject' | 'secondary';
};

// =============================================================================
// Configuration
// =============================================================================

/** Icon for each prompt type header */
const PROMPT_ICONS: Record<PromptState['kind'], string> = {
  toolEdit: 'codicon-diff',
  bash: 'codicon-terminal',
  retry: 'codicon-refresh',
  proposal: 'codicon-rocket',
};

/** Title for each prompt type */
const PROMPT_TITLES: Record<PromptState['kind'], string> = {
  toolEdit: 'Tool edit approval',
  bash: 'Command approval',
  retry: 'Retry request',
  proposal: 'Agent proposal',
};

/** Primary actions (approve/reject) for each prompt type */
const PRIMARY_ACTIONS: Record<PromptState['kind'], ActionConfig[]> = {
  toolEdit: [
    {
      action: 'approve',
      label: 'Approve',
      icon: 'codicon-check',
      variant: 'approve',
    },
    { action: 'reject', label: 'Reject', icon: 'codicon-x', variant: 'reject' },
  ],
  bash: [
    {
      action: 'approve',
      label: 'Approve',
      icon: 'codicon-check',
      variant: 'approve',
    },
    { action: 'reject', label: 'Reject', icon: 'codicon-x', variant: 'reject' },
  ],
  retry: [
    {
      action: 'retry',
      label: 'Retry',
      icon: 'codicon-refresh',
      variant: 'approve',
    },
    { action: 'cancel', label: 'Cancel', icon: 'codicon-x', variant: 'reject' },
  ],
  proposal: [
    {
      action: 'approve',
      label: 'Approve',
      icon: 'codicon-check',
      variant: 'approve',
    },
    { action: 'reject', label: 'Reject', icon: 'codicon-x', variant: 'reject' },
  ],
};

/** Secondary actions for each prompt type */
const SECONDARY_ACTIONS: Record<PromptState['kind'], ActionConfig[]> = {
  toolEdit: [
    {
      action: 'openDiff',
      label: 'Diff',
      icon: 'codicon-diff',
      variant: 'secondary',
    },
    {
      action: 'previewProposed',
      label: 'Preview',
      icon: 'codicon-eye',
      variant: 'secondary',
    },
    {
      action: 'showLatexdiff',
      label: 'LaTeXdiff',
      icon: '',
      variant: 'secondary',
    },
  ],
  bash: [],
  retry: [],
  proposal: [
    {
      action: 'setup',
      label: 'Setup',
      icon: 'codicon-gear',
      variant: 'secondary',
    },
  ],
};

// =============================================================================
// Component
// =============================================================================

@customElement('prompt-overlay')
export class PromptOverlay extends LitElement {
  static styles = [
    designTokens,
    codiconIconClasses,
    css`
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      /* Card container */
      .prompt-card {
        border: 1px solid var(--vscode-input-border);
        border-radius: var(--border-radius-medium);
        background: var(--vscode-editor-background);
        margin-bottom: var(--spacing-medium);
      }

      /* Header */
      .prompt-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-small) var(--spacing-medium);
        font-weight: 500;
        border-bottom: 1px solid var(--vscode-input-border);
      }

      .prompt-header .codicon {
        color: var(--vscode-terminal-ansiYellow);
      }

      /* Body */
      .prompt-body {
        padding: var(--spacing-medium);
        font-size: var(--font-size);
        line-height: 1.5;
      }

      .prompt-body p {
        margin: 0 0 var(--spacing-small);
      }

      .prompt-body p:last-child {
        margin-bottom: 0;
      }

      /* Code block for commands */
      .code-block {
        display: block;
        padding: var(--spacing-medium);
        background: var(--vscode-textCodeBlock-background);
        border-radius: var(--border-radius);
        color: var(--vscode-terminal-foreground);
        font-family: var(--vscode-editor-font-family);
        font-size: var(--font-size-sm);
        white-space: pre-wrap;
        word-break: break-word;
        overflow-x: auto;
      }

      /* Actions bar */
      .prompt-actions {
        display: flex;
        align-items: center;
        gap: var(--spacing-medium);
        padding: var(--spacing-small) var(--spacing-medium);
        border-top: 1px solid var(--vscode-input-border);
      }

      .secondary-actions {
        margin-left: auto;
        display: flex;
        gap: var(--spacing-small);
      }

      /* Action buttons */
      .action-button {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-tiny);
        padding: var(--spacing-tiny) var(--spacing-small);
        background: transparent;
        border: none;
        color: var(--vscode-foreground);
        font-size: var(--font-size);
        cursor: pointer;
        border-radius: var(--border-radius);
      }

      .action-button:hover {
        background: var(--vscode-toolbar-hoverBackground);
      }

      .action-button--approve {
        color: var(--vscode-testing-iconPassed, #89d185);
      }

      .action-button--reject {
        color: var(--vscode-testing-iconFailed, #f48771);
      }

      .action-button--secondary {
        color: var(--vscode-descriptionForeground);
      }

      /* File path styling */
      .file-path {
        font-family: var(--vscode-editor-font-family);
        font-size: var(--font-size-sm);
        color: var(--color-text-link);
        word-break: break-word;
      }

      /* Diff info styling */
      .diff-info {
        display: inline-flex;
        align-items: baseline;
        gap: var(--spacing-small);
        font-size: var(--font-size-sm);
      }

      .diff-added {
        color: var(--color-added);
      }

      .diff-removed {
        color: var(--color-removed);
      }

      .meta-text {
        color: var(--vscode-descriptionForeground);
        margin-left: var(--spacing-small);
      }

      /* File list styling */
      .file-list {
        margin: var(--spacing-tiny) 0;
      }

      .file-list-label {
        color: var(--vscode-descriptionForeground);
        margin-right: var(--spacing-tiny);
      }

      .file-link {
        color: var(--vscode-textLink-foreground);
        cursor: pointer;
        text-decoration: none;
      }

      .file-link:hover {
        text-decoration: underline;
      }

      /* Feedback section */
      .feedback-section {
        margin-top: var(--spacing-small);
      }

      .feedback-label {
        display: block;
        margin-bottom: var(--spacing-tiny);
        font-size: var(--font-size-sm);
        color: var(--vscode-descriptionForeground);
      }

      .feedback-input {
        width: 100%;
        min-height: 60px;
        padding: var(--spacing-small);
        border: 1px solid var(--vscode-input-border);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border-radius: var(--border-radius);
        font-family: inherit;
        font-size: var(--font-size-sm);
        resize: vertical;
        box-sizing: border-box;
      }

      .feedback-input:focus {
        outline: 1px solid var(--vscode-focusBorder);
      }
    `,
  ];

  @property({ type: Object }) prompt: PromptState | null = null;
  @state() private showFeedback = false;
  @query('.feedback-input') private feedbackInput?: HTMLTextAreaElement;

  protected willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('prompt')) {
      this.showFeedback = false;
    }
  }

  render(): TemplateResult | typeof nothing {
    if (!this.prompt) return nothing;

    return html`
      <div class="prompt-card">
        <div class="prompt-header">
          <i class="codicon ${PROMPT_ICONS[this.prompt.kind]}"></i>
          <span>${this.getTitle()}</span>
        </div>
        <div class="prompt-body">${this.renderBody()}</div>
        <div class="prompt-actions">${this.renderActions()}</div>
      </div>
    `;
  }

  // ===========================================================================
  // Title
  // ===========================================================================

  private getTitle(): string {
    if (!this.prompt) return '';

    if (this.prompt.kind === 'proposal') {
      const isWorkflow =
        this.prompt.data.agentCategory === AGENT_CATEGORY.WORKFLOW;
      return `Agent proposal (${isWorkflow ? 'Workflow' : 'Tool-Use'})`;
    }

    return PROMPT_TITLES[this.prompt.kind];
  }

  // ===========================================================================
  // Body rendering
  // ===========================================================================

  private renderBody(): TemplateResult | typeof nothing {
    if (!this.prompt) return nothing;

    switch (this.prompt.kind) {
      case 'toolEdit':
        return this.renderToolEditBody(this.prompt.data);
      case 'bash':
        return this.renderBashBody(this.prompt.data);
      case 'retry':
        return this.renderRetryBody(this.prompt.data);
      case 'proposal':
        return this.renderProposalBody(this.prompt.data);
      default:
        return nothing;
    }
  }

  private renderToolEditBody(prompt: ToolEditApprovalPrompt): TemplateResult {
    return html`
      <p>
        <span class="file-path">${prompt.relativePath || prompt.path}</span>
      </p>
      <p>
        <span class="diff-info">
          <span class="diff-added">+${prompt.addedLines}</span>
          <span class="diff-removed">-${prompt.removedLines}</span>
        </span>
        <span class="meta-text">via ${prompt.sourceTool}</span>
      </p>
      ${this.renderFeedbackSection()}
    `;
  }

  private renderBashBody(prompt: BashApprovalPrompt): TemplateResult {
    return html`
      <code class="code-block">${prompt.command}</code>
      ${this.renderFeedbackSection()}
    `;
  }

  private renderRetryBody(prompt: RetryRequestPrompt): TemplateResult {
    return html`
      <p><strong>Operation:</strong> ${prompt.operation}</p>
      ${when(
        prompt.errorMessage,
        () => html`<p><strong>Error:</strong> ${prompt.errorMessage}</p>`,
      )}
      ${this.renderFeedbackSection()}
    `;
  }

  private renderProposalBody(prompt: AgentProposalPrompt): TemplateResult {
    const isWorkflow = prompt.agentCategory === AGENT_CATEGORY.WORKFLOW;

    return html`
      <p><strong>Agent:</strong> ${prompt.agent}</p>
      <p><strong>Model:</strong> ${prompt.model}</p>
      <p><strong>Instruction:</strong> ${prompt.instruction}</p>
      ${isWorkflow
        ? this.renderWorkflowFiles(prompt as WorkflowAgentProposalPrompt)
        : nothing}
      ${this.renderFeedbackSection()}
    `;
  }

  /** Render feedback section (shared across all prompt types) */
  private renderFeedbackSection(): TemplateResult | typeof nothing {
    if (!this.showFeedback) return nothing;

    return html`
      <div class="feedback-section">
        <label class="feedback-label">Rejection feedback (optional):</label>
        <textarea
          class="feedback-input"
          placeholder="Why are you rejecting?"
        ></textarea>
      </div>
    `;
  }

  private renderWorkflowFiles(
    prompt: WorkflowAgentProposalPrompt,
  ): TemplateResult {
    const combine = (single: string | null | undefined, arr: string[] = []) =>
      [single, ...arr].filter((f): f is string => Boolean(f));

    const fileLists = [
      { label: 'Input', files: combine(prompt.inputFile, prompt.inputFiles) },
      {
        label: 'Reference',
        files: combine(prompt.referenceFile, prompt.referenceFiles),
      },
      {
        label: 'Auxiliary',
        files: combine(prompt.auxiliaryFile, prompt.auxiliaryFiles),
      },
      { label: 'Media', files: combine(prompt.mediaFile, prompt.mediaFiles) },
      { label: 'Output', files: prompt.outputFiles ?? [] },
    ];

    return html`${repeat(
      fileLists,
      ({ label }) => label,
      ({ label, files }) => this.renderFileList(label, files),
    )}`;
  }

  private renderFileList(
    label: string,
    files: string[],
  ): TemplateResult | typeof nothing {
    if (files.length === 0) return nothing;

    return html`
      <div class="file-list">
        <span class="file-list-label">${label}:</span>
        ${repeat(
          files,
          (file) => file,
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

  // ===========================================================================
  // Actions rendering (DRY)
  // ===========================================================================

  private renderActions(): TemplateResult | typeof nothing {
    if (!this.prompt) return nothing;

    const primaryActions = PRIMARY_ACTIONS[this.prompt.kind];
    const secondaryActions = SECONDARY_ACTIONS[this.prompt.kind];

    return html`
      ${repeat(
        primaryActions,
        (config) => config.action,
        (config) => this.renderActionButton(config),
      )}
      ${secondaryActions.length > 0
        ? html`
            <div class="secondary-actions">
              ${repeat(
                secondaryActions,
                (config) => config.action,
                (config) => this.renderActionButton(config),
              )}
            </div>
          `
        : nothing}
    `;
  }

  private renderActionButton(config: ActionConfig): TemplateResult {
    const { action, label, icon, variant } = config;

    // Show "Submit" for reject/cancel when feedback is active
    const isRejectAction = action === 'reject' || action === 'cancel';
    const displayLabel = isRejectAction && this.showFeedback ? 'Submit' : label;

    return html`
      <button
        class="action-button action-button--${variant}"
        data-action=${action}
        @click=${this.handleActionClick}
      >
        ${icon ? html`<i class="codicon ${icon}"></i>` : nothing}
        ${displayLabel}
      </button>
    `;
  }

  // ===========================================================================
  // Event handlers
  // ===========================================================================

  private handleActionClick = (event: MouseEvent): void => {
    const target = event.currentTarget as HTMLElement | null;
    const action = target?.dataset.action;
    if (!action) return;

    // Special handling for reject/cancel actions (show feedback first)
    if (action === 'reject' || action === 'cancel') {
      this.handleRejectClick(action);
      return;
    }

    this.emitAction(action);
  };

  private handleRejectClick(action: string): void {
    if (!this.showFeedback) {
      // First click: show feedback form
      this.showFeedback = true;
      this.updateComplete.then(() => {
        this.feedbackInput?.focus();
      });
      return;
    }

    // Second click: submit with feedback
    const feedback = this.feedbackInput?.value?.trim() || undefined;
    this.emitAction(action, feedback);
    this.showFeedback = false;
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
