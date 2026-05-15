// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import { AGENT_CATEGORY } from '@shared/schemas';
import { postMessage } from '@shared/hostBridge';
import type {
  AgentOptionData,
  AgentProposalPermission,
  BashPermission,
  ExternalInquiryPermission,
  ModelOptionData,
  PlanApprovalPermission,
  RetryPermission,
  ToolEditPermission,
  UserQuestionPermission,
  WorkflowAgentProposalPermission,
} from '@shared/schemas';
import { getProposalFileGroups } from '@shared/schemas/proposalFields';
import { getBasename } from '@shared/utils/path';
import { getTextareaValue } from '@shared/utils/textarea';
import {
  FEEDBACK_ELIGIBLE_KINDS,
  PERMISSION_KIND,
} from '@shared/utils/uiConstants';
import { designTokens } from '@shared/styles/litStyles';
import { filledButtonStyles } from '@shared/styles/commonViewStyles';
import { permissionCardStyles } from '@shared/styles/permissionCardStyles';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';

// Local imports - progress view
import { ProgressEvents } from '../events';

// =============================================================================
// Types
// =============================================================================

export type PermissionState =
  | { kind: typeof PERMISSION_KIND.TOOL_EDIT; data: ToolEditPermission }
  | { kind: typeof PERMISSION_KIND.BASH; data: BashPermission }
  | { kind: typeof PERMISSION_KIND.RETRY; data: RetryPermission }
  | {
      kind: typeof PERMISSION_KIND.PROPOSAL;
      data: AgentProposalPermission;
      modelOptions?: ModelOptionData[];
      agentOptions?: AgentOptionData[];
    }
  | {
      kind: typeof PERMISSION_KIND.PLAN_APPROVAL;
      data: PlanApprovalPermission;
    }
  | {
      kind: typeof PERMISSION_KIND.EXTERNAL_INQUIRY;
      data: ExternalInquiryPermission;
    }
  | {
      kind: typeof PERMISSION_KIND.USER_QUESTION;
      data: UserQuestionPermission;
    };

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

/** wa-icon name for each permission type header */
const PERMISSION_ICONS: Record<PermissionState['kind'], string> = {
  [PERMISSION_KIND.TOOL_EDIT]: 'diff',
  [PERMISSION_KIND.BASH]: 'terminal',
  [PERMISSION_KIND.RETRY]: 'refresh',
  [PERMISSION_KIND.PROPOSAL]: 'rocket',
  [PERMISSION_KIND.PLAN_APPROVAL]: 'tasklist',
  [PERMISSION_KIND.EXTERNAL_INQUIRY]: 'globe',
  [PERMISSION_KIND.USER_QUESTION]: 'circle-question',
};

/** Title for each permission type */
const PERMISSION_TITLES: Record<PermissionState['kind'], string> = {
  [PERMISSION_KIND.TOOL_EDIT]: 'Approve file edit',
  [PERMISSION_KIND.BASH]: 'Approve command',
  [PERMISSION_KIND.RETRY]: 'Retry request',
  [PERMISSION_KIND.PROPOSAL]: 'Approve task',
  [PERMISSION_KIND.PLAN_APPROVAL]: 'Approve plan',
  [PERMISSION_KIND.EXTERNAL_INQUIRY]: 'External inquiry',
  [PERMISSION_KIND.USER_QUESTION]: 'Question',
};

/** Primary actions (approve/reject) for each permission type */
const PRIMARY_ACTIONS: Record<PermissionState['kind'], ActionConfig[]> = {
  [PERMISSION_KIND.TOOL_EDIT]: [
    { action: 'approve', label: 'Approve', icon: 'check', variant: 'approve' },
    { action: 'reject', label: 'Reject', icon: 'x', variant: 'reject' },
  ],
  [PERMISSION_KIND.BASH]: [
    { action: 'approve', label: 'Approve', icon: 'check', variant: 'approve' },
    { action: 'reject', label: 'Reject', icon: 'x', variant: 'reject' },
  ],
  [PERMISSION_KIND.RETRY]: [
    { action: 'retry', label: 'Retry', icon: 'refresh', variant: 'approve' },
    { action: 'cancel', label: 'Cancel', icon: 'x', variant: 'reject' },
  ],
  [PERMISSION_KIND.PROPOSAL]: [
    { action: 'approve', label: 'Approve', icon: 'check', variant: 'approve' },
    { action: 'reject', label: 'Reject', icon: 'x', variant: 'reject' },
  ],
  [PERMISSION_KIND.PLAN_APPROVAL]: [
    { action: 'approve', label: 'Approve', icon: 'check', variant: 'approve' },
    { action: 'reject', label: 'Reject', icon: 'x', variant: 'reject' },
  ],
  // External inquiry uses its own panel with answer textarea; only reject here as fallback.
  [PERMISSION_KIND.EXTERNAL_INQUIRY]: [
    { action: 'reject', label: 'Reject', icon: 'x', variant: 'reject' },
  ],
  [PERMISSION_KIND.USER_QUESTION]: [
    { action: 'reject', label: 'Reject', icon: 'x', variant: 'reject' },
  ],
};

/** Secondary actions for each permission type */
const SECONDARY_ACTIONS: Record<PermissionState['kind'], ActionConfig[]> = {
  [PERMISSION_KIND.TOOL_EDIT]: [
    { action: 'openDiff', label: 'Diff', icon: 'diff', variant: 'secondary' },
    {
      action: 'previewProposed',
      label: 'Preview',
      icon: 'eye',
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
    { action: 'setup', label: 'Setup', icon: 'reply', variant: 'secondary' },
  ],
  [PERMISSION_KIND.PLAN_APPROVAL]: [],
  [PERMISSION_KIND.EXTERNAL_INQUIRY]: [],
  [PERMISSION_KIND.USER_QUESTION]: [],
};

// =============================================================================
// Component
// =============================================================================

@customElement('permission-card')
export class PermissionCard extends LitElement {
  static override styles = [
    designTokens,
    filledButtonStyles,
    permissionCardStyles,
  ];

  @property({ attribute: false }) permission: PermissionState | null = null;
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
          <wa-icon
            library="texra"
            name=${PERMISSION_ICONS[this.permission.kind]}
            aria-hidden="true"
          ></wa-icon>
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
      return this.permission.data.agentCategory === AGENT_CATEGORY.WORKFLOW
        ? 'Approve task (Workflow)'
        : 'Approve task (Interactive)';
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
      case PERMISSION_KIND.PLAN_APPROVAL:
        return this.renderPlanApprovalBody(this.permission.data);
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
    return html`
      <p><strong>Agent:</strong> ${data.agent}</p>
      <p><strong>Model:</strong> ${data.model}</p>
      <p><strong>Instruction:</strong> ${data.instruction}</p>
      ${data.workingDirectory
        ? html`<p>
            <strong>Working directory:</strong>
            <span class="file-path">${data.workingDirectory}</span>
          </p>`
        : nothing}
      ${data.agentCategory === AGENT_CATEGORY.WORKFLOW
        ? this.renderExtractFlags(data)
        : nothing}
      ${this.renderFileGroups(data)} ${this.renderFeedbackSection()}
    `;
  }

  private renderExtractFlags(
    data: WorkflowAgentProposalPermission,
  ): TemplateResult | typeof nothing {
    const flags: string[] = [];
    if (data.toolConfig.autoExtractFigure) flags.push('Extract Figures');
    if (data.toolConfig.autoExtractTikzFigure) flags.push('Extract TikZ');
    if (flags.length === 0) return nothing;
    return html`<p class="extract-flags">
      ${repeat(
        flags,
        (flag) => flag,
        (flag) =>
          html`<span class="extract-flag"
            ><wa-icon
              library="texra"
              name="file-media"
              aria-hidden="true"
            ></wa-icon>
            ${flag}</span
          >`,
      )}
    </p>`;
  }

  private renderPlanApprovalBody(data: PlanApprovalPermission): TemplateResult {
    const { plan } = data;

    return html`
      <p><strong>${plan.summary}</strong></p>
      <ol class="plan-steps-list">
        ${repeat(
          plan.steps,
          (_step, index) => index,
          (step) => html`
            <li>
              ${step.title}
              ${step.description
                ? html`<span class="meta-text"> — ${step.description}</span>`
                : nothing}
            </li>
          `,
        )}
      </ol>
      ${this.renderFeedbackSection()}
    `;
  }

  /** Render feedback section (shared across all permission types) */
  private renderFeedbackSection(): TemplateResult | typeof nothing {
    if (!this.showFeedback || !this.canCollectFeedback()) return nothing;

    return html`
      <div class="feedback-section">
        <label class="feedback-label">Rejection feedback (optional):</label>
        <wa-textarea
          class="feedback-input"
          placeholder="Why are you rejecting?"
          rows="2"
        ></wa-textarea>
      </div>
    `;
  }

  private renderFileGroups(data: AgentProposalPermission): TemplateResult {
    return html`${repeat(
      getProposalFileGroups(data),
      ({ label }) => label,
      ({ label, files, clickable }) =>
        this.renderFileList(label, files, clickable),
    )}`;
  }

  private renderFileList(
    label: string,
    files: string[],
    clickable: boolean,
  ): TemplateResult | typeof nothing {
    if (files.length === 0) return nothing;

    return html`
      <div class="file-list" @click=${this.handleFileClick}>
        <span class="file-list-label">${label}:</span>
        ${repeat(
          files,
          (file) => file,
          (file, i) =>
            html`${i > 0 ? ', ' : ''}<span
                class="${clickable ? 'file-link' : 'file-label'}"
                title=${file}
                data-file=${ifDefined(clickable ? file : undefined)}
                >${getBasename(file)}</span
              >`,
        )}
      </div>
    `;
  }

  private handleFileClick(event: MouseEvent): void {
    const file = (event.target as HTMLElement).dataset.file;
    if (file) {
      postMessage(PROGRESS_VIEW_COMMANDS.OPEN_FILE, { file });
    }
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
        class="filled-button filled-button--${variant}"
        data-action=${action}
        @click=${this.handleActionClick}
      >
        ${icon
          ? html`<wa-icon
              library="texra"
              name=${icon}
              aria-hidden="true"
            ></wa-icon>`
          : nothing}
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

  private canCollectFeedback(): boolean {
    return Boolean(
      this.permission && FEEDBACK_ELIGIBLE_KINDS.has(this.permission.kind),
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
