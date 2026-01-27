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
import { promptOverlayStyles } from '@shared/styles/promptOverlayStyles';

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

/** Prompt kinds that support rejection feedback */
const FEEDBACK_ELIGIBLE_PROMPTS = new Set<PromptState['kind']>([
  'toolEdit',
  'bash',
  'proposal',
]);

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
  static styles = [designTokens, codiconIconClasses, promptOverlayStyles];

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
      <div class="prompt-card" data-type=${this.prompt.kind}>
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
    if (!this.showFeedback || !this.canCollectFeedback()) return nothing;

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
      <div class="primary-actions">
        ${repeat(
          primaryActions,
          (config) => config.action,
          (config) => this.renderActionButton(config),
        )}
      </div>
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
    const displayLabel =
      isRejectAction && this.showFeedback && this.canCollectFeedback()
        ? 'Submit'
        : label;

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

  private handleActionClick(event: MouseEvent): void {
    const target = event.currentTarget as HTMLElement | null;
    const action = target?.dataset.action;
    if (!action) return;

    // Special handling for reject/cancel actions (show feedback first)
    if (
      (action === 'reject' || action === 'cancel') &&
      this.canCollectFeedback()
    ) {
      this.handleRejectClick(action);
      return;
    }

    this.emitAction(action);
  }

  private handleRejectClick(action: string): void {
    if (!this.canCollectFeedback()) {
      this.emitAction(action);
      return;
    }

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

  private canCollectFeedback(): boolean {
    return Boolean(
      this.prompt && FEEDBACK_ELIGIBLE_PROMPTS.has(this.prompt.kind),
    );
  }

  private emitAction(action: string, feedback?: string) {
    if (!this.prompt) return;
    this.dispatchEvent(
      ProgressEvents.promptAction({ prompt: this.prompt, action, feedback }),
    );
  }
}
