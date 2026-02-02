// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared
import { AGENT_CATEGORY } from '@shared/schemas';
import { getBasename } from '@shared/utils/path';
import { getTextareaValue } from '@shared/utils/textarea';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { postMessage } from '@shared/vscode';
import { designTokens } from '@shared/styles/litStyles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';
import { permissionCardStyles } from '@shared/styles/permissionCardStyles';

// Local imports - webview commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view
import { ProgressEvents } from '../events';
import type {
  AgentProposalPermission,
  BashPermission,
  RetryPermission,
  ToolEditPermission,
  WorkflowAgentProposalPermission,
} from '@shared/schemas';

// =============================================================================
// Types
// =============================================================================

export type PermissionState =
  | { kind: typeof PERMISSION_KIND.TOOL_EDIT; data: ToolEditPermission }
  | { kind: typeof PERMISSION_KIND.BASH; data: BashPermission }
  | { kind: typeof PERMISSION_KIND.RETRY; data: RetryPermission }
  | { kind: typeof PERMISSION_KIND.PROPOSAL; data: AgentProposalPermission };

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

/** Icon for each permission type header */
const PERMISSION_ICONS: Record<PermissionState['kind'], string> = {
  [PERMISSION_KIND.TOOL_EDIT]: 'codicon-diff',
  [PERMISSION_KIND.BASH]: 'codicon-terminal',
  [PERMISSION_KIND.RETRY]: 'codicon-refresh',
  [PERMISSION_KIND.PROPOSAL]: 'codicon-rocket',
};

/** Title for each permission type */
const PERMISSION_TITLES: Record<PermissionState['kind'], string> = {
  [PERMISSION_KIND.TOOL_EDIT]: 'Tool edit approval',
  [PERMISSION_KIND.BASH]: 'Command approval',
  [PERMISSION_KIND.RETRY]: 'Retry request',
  [PERMISSION_KIND.PROPOSAL]: 'Agent proposal',
};

/** Prompt kinds that support rejection feedback */
const FEEDBACK_ELIGIBLE_PERMISSIONS = new Set<PermissionState['kind']>([
  PERMISSION_KIND.TOOL_EDIT,
  PERMISSION_KIND.BASH,
  PERMISSION_KIND.PROPOSAL,
]);

/** Primary actions (approve/reject) for each permission type */
const PRIMARY_ACTIONS: Record<PermissionState['kind'], ActionConfig[]> = {
  [PERMISSION_KIND.TOOL_EDIT]: [
    {
      action: 'approve',
      label: 'Approve',
      icon: 'codicon-check',
      variant: 'approve',
    },
    { action: 'reject', label: 'Reject', icon: 'codicon-x', variant: 'reject' },
  ],
  [PERMISSION_KIND.BASH]: [
    {
      action: 'approve',
      label: 'Approve',
      icon: 'codicon-check',
      variant: 'approve',
    },
    { action: 'reject', label: 'Reject', icon: 'codicon-x', variant: 'reject' },
  ],
  [PERMISSION_KIND.RETRY]: [
    {
      action: 'retry',
      label: 'Retry',
      icon: 'codicon-refresh',
      variant: 'approve',
    },
    { action: 'cancel', label: 'Cancel', icon: 'codicon-x', variant: 'reject' },
  ],
  [PERMISSION_KIND.PROPOSAL]: [
    {
      action: 'approve',
      label: 'Approve',
      icon: 'codicon-check',
      variant: 'approve',
    },
    { action: 'reject', label: 'Reject', icon: 'codicon-x', variant: 'reject' },
  ],
};

/** Secondary actions for each permission type */
const SECONDARY_ACTIONS: Record<PermissionState['kind'], ActionConfig[]> = {
  [PERMISSION_KIND.TOOL_EDIT]: [
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
  [PERMISSION_KIND.BASH]: [],
  [PERMISSION_KIND.RETRY]: [],
  [PERMISSION_KIND.PROPOSAL]: [
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

@customElement('permission-card')
export class PermissionCard extends LitElement {
  static override styles = [
    designTokens,
    codiconIconClasses,
    permissionCardStyles,
  ];

  @property({ type: Object }) permission: PermissionState | null = null;
  @state() private showFeedback = false;
  @query('.feedback-input') private feedbackInput?: HTMLElement;

  protected willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('permission')) {
      this.showFeedback = false;
    }
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.permission) return nothing;

    return html`
      <div class="permission-card" data-type=${this.permission.kind}>
        <div class="permission-header">
          <i class="codicon ${PERMISSION_ICONS[this.permission.kind]}"></i>
          <span>${this.getTitle()}</span>
        </div>
        <div class="permission-body">${this.renderBody()}</div>
        <div class="permission-actions">${this.renderActions()}</div>
      </div>
    `;
  }

  // ===========================================================================
  // Title
  // ===========================================================================

  private getTitle(): string {
    if (!this.permission) return '';

    if (this.permission.kind === PERMISSION_KIND.PROPOSAL) {
      const isWorkflow =
        this.permission.data.agentCategory === AGENT_CATEGORY.WORKFLOW;
      return `Agent proposal (${isWorkflow ? 'Workflow' : 'Tool-Use'})`;
    }

    return PERMISSION_TITLES[this.permission.kind];
  }

  // ===========================================================================
  // Body rendering
  // ===========================================================================

  private renderBody(): TemplateResult | typeof nothing {
    if (!this.permission) return nothing;

    switch (this.permission.kind) {
      case PERMISSION_KIND.TOOL_EDIT:
        return this.renderToolEditBody(this.permission.data);
      case PERMISSION_KIND.BASH:
        return this.renderBashBody(this.permission.data);
      case PERMISSION_KIND.RETRY:
        return this.renderRetryBody(this.permission.data);
      case PERMISSION_KIND.PROPOSAL:
        return this.renderProposalBody(this.permission.data);
      default:
        return nothing;
    }
  }

  private renderToolEditBody(data: ToolEditPermission): TemplateResult {
    return html`
      <p>
        <span class="file-path">${data.relativePath || data.path}</span>
      </p>
      <p>
        <span class="diff-info">
          <span class="diff-added">+${data.addedLines}</span>
          <span class="diff-removed">-${data.removedLines}</span>
        </span>
        <span class="meta-text">via ${data.sourceTool}</span>
      </p>
      ${this.renderFeedbackSection()}
    `;
  }

  private renderBashBody(data: BashPermission): TemplateResult {
    return html`
      <code class="code-block">${data.command}</code>
      ${this.renderFeedbackSection()}
    `;
  }

  private renderRetryBody(data: RetryPermission): TemplateResult {
    return html`
      <p><strong>Operation:</strong> ${data.operation}</p>
      ${when(
        data.errorMessage,
        () => html`<p><strong>Error:</strong> ${data.errorMessage}</p>`,
      )}
      ${this.renderFeedbackSection()}
    `;
  }

  private renderProposalBody(data: AgentProposalPermission): TemplateResult {
    const isWorkflow = data.agentCategory === AGENT_CATEGORY.WORKFLOW;

    return html`
      <p><strong>Agent:</strong> ${data.agent}</p>
      <p><strong>Model:</strong> ${data.model}</p>
      <p><strong>Instruction:</strong> ${data.instruction}</p>
      ${isWorkflow
        ? this.renderWorkflowFiles(data as WorkflowAgentProposalPermission)
        : nothing}
      ${this.renderFeedbackSection()}
    `;
  }

  /** Render feedback section (shared across all permission types) */
  private renderFeedbackSection(): TemplateResult | typeof nothing {
    if (!this.showFeedback || !this.canCollectFeedback()) return nothing;

    return html`
      <div class="feedback-section">
        <label class="feedback-label">Rejection feedback (optional):</label>
        <vscode-textarea
          class="feedback-input"
          placeholder="Why are you rejecting?"
          rows="2"
        ></vscode-textarea>
      </div>
    `;
  }

  private renderWorkflowFiles(
    data: WorkflowAgentProposalPermission,
  ): TemplateResult {
    const combine = (single: string | null | undefined, arr: string[] = []) =>
      [single, ...arr].filter((f): f is string => Boolean(f));

    const fileLists = [
      { label: 'Input', files: combine(data.inputFile, data.inputFiles) },
      {
        label: 'Reference',
        files: combine(data.referenceFile, data.referenceFiles),
      },
      {
        label: 'Auxiliary',
        files: combine(data.auxiliaryFile, data.auxiliaryFiles),
      },
      { label: 'Media', files: combine(data.mediaFile, data.mediaFiles) },
      { label: 'Output', files: data.outputFiles ?? [] },
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
    if (!this.permission) return nothing;

    const primaryActions = PRIMARY_ACTIONS[this.permission.kind];
    const secondaryActions = SECONDARY_ACTIONS[this.permission.kind];

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
    const feedback = getTextareaValue(this.feedbackInput).trim() || undefined;
    this.emitAction(action, feedback);
    this.showFeedback = false;
  }

  private openFile(filePath: string): void {
    postMessage(PROGRESS_VIEW_COMMANDS.OPEN_FILE, { file: filePath });
  }

  private canCollectFeedback(): boolean {
    return Boolean(
      this.permission &&
      FEEDBACK_ELIGIBLE_PERMISSIONS.has(this.permission.kind),
    );
  }

  private emitAction(action: string, feedback?: string) {
    if (!this.permission) return;
    this.dispatchEvent(
      ProgressEvents.permissionAction({
        permission: this.permission,
        action,
        feedback,
      }),
    );
  }
}
