// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { classMap } from 'lit/directives/class-map.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared styles
import {
  codiconIconClasses,
  commonViewStyles,
  designTokens,
  requestPanelStyles,
} from '@shared/styles';

// Local imports - shared schemas
import {
  AGENT_CATEGORY,
  type AgentProposalPermission,
  type BashPermission,
  type ProviderErrorPartial,
  type RetryPermission,
  type ToolEditPermission,
  type WorkflowAgentProposalPermission,
} from '@shared/schemas';

// Local imports - shared utilities
import { getBasename } from '@shared/utils/path';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { postMessage } from '@shared/vscode';

// Local imports - webview commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view events
import { ProgressEvents } from '../events';

// Local imports - progress view component types
import type { PermissionState } from './PermissionCard';

const FEEDBACK_KINDS = new Set<PermissionState['kind']>([
  PERMISSION_KIND.TOOL_EDIT,
  PERMISSION_KIND.PROPOSAL,
]);

type PermissionKey = string;

@customElement('request-panels')
export class RequestPanels extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconIconClasses,
    requestPanelStyles,
  ];

  @property({ type: Array }) permissions: PermissionState[] = [];

  @state() private feedbackOpenKeys: Set<PermissionKey> = new Set();
  @state() private openDiffMenuKey: PermissionKey | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('click', this.handleActionClick);
    document.addEventListener('click', this.handleOutsideClick, true);
  }

  override disconnectedCallback(): void {
    this.removeEventListener('click', this.handleActionClick);
    document.removeEventListener('click', this.handleOutsideClick, true);
    super.disconnectedCallback();
  }

  override render(): TemplateResult | typeof nothing {
    const approvals = this.permissions.filter(
      (p) => p.kind === PERMISSION_KIND.TOOL_EDIT,
    );
    const bashApprovals = this.permissions.filter(
      (p) => p.kind === PERMISSION_KIND.BASH,
    );
    const retries = this.permissions.filter(
      (p) => p.kind === PERMISSION_KIND.RETRY,
    );
    const proposals = this.permissions.filter(
      (p) => p.kind === PERMISSION_KIND.PROPOSAL,
    );

    if (
      approvals.length === 0 &&
      bashApprovals.length === 0 &&
      retries.length === 0 &&
      proposals.length === 0
    ) {
      return nothing;
    }

    return html`
      ${this.renderApprovalSection(approvals)}
      ${this.renderBashSection(bashApprovals)}
      ${this.renderRetrySection(retries)}
      ${this.renderProposalSection(proposals)}
    `;
  }

  // ===========================================================================
  // Section renderers
  // ===========================================================================

  private renderApprovalSection(
    prompts: PermissionState[],
  ): TemplateResult | typeof nothing {
    if (prompts.length === 0) return nothing;

    return html`
      <section class="approval-requests">
        <div class="approval-requests__header">
          <i class="codicon codicon-diff"></i>
          <span>Tool edit approval</span>
        </div>
        <div class="approval-requests__list">
          ${repeat(
            prompts,
            (permission) => this.getPermissionKey(permission),
            (permission) => this.renderToolEditRequest(permission),
          )}
        </div>
      </section>
    `;
  }

  private renderBashSection(
    prompts: PermissionState[],
  ): TemplateResult | typeof nothing {
    if (prompts.length === 0) return nothing;

    return html`
      <section class="bash-approval-requests">
        <div class="bash-approval-requests__header">
          <i class="codicon codicon-terminal"></i>
          <span>Command approval</span>
        </div>
        <div class="bash-approval-requests__list">
          ${repeat(
            prompts,
            (permission) => this.getPermissionKey(permission),
            (permission) => this.renderBashRequest(permission),
          )}
        </div>
      </section>
    `;
  }

  private renderRetrySection(
    prompts: PermissionState[],
  ): TemplateResult | typeof nothing {
    if (prompts.length === 0) return nothing;

    return html`
      <section class="retry-requests">
        <div class="retry-requests__header">
          <i class="codicon codicon-refresh"></i>
          <span>Retry request</span>
        </div>
        <div class="retry-requests__list">
          ${repeat(
            prompts,
            (permission) => this.getPermissionKey(permission),
            (permission) => this.renderRetryRequest(permission),
          )}
        </div>
      </section>
    `;
  }

  private renderProposalSection(
    prompts: PermissionState[],
  ): TemplateResult | typeof nothing {
    if (prompts.length === 0) return nothing;

    return html`
      <section class="workflow-proposals">
        <div class="workflow-proposals__header">
          <i class="codicon codicon-rocket"></i>
          <span>Agent proposal</span>
        </div>
        <div class="workflow-proposals__list">
          ${repeat(
            prompts,
            (permission) => this.getPermissionKey(permission),
            (permission) => this.renderProposalRequest(permission),
          )}
        </div>
      </section>
    `;
  }

  // ===========================================================================
  // Individual request renderers
  // ===========================================================================

  private renderToolEditRequest(permission: PermissionState): TemplateResult {
    const data = permission.data as ToolEditPermission;
    const key = this.getPermissionKey(permission);
    const isFeedbackOpen = this.feedbackOpenKeys.has(key);
    const diffMeta = this.renderToolEditDiffMeta(data);

    return html`
      <div
        class=${classMap({
          'approval-request': true,
          'approval-request--feedback-active': isFeedbackOpen,
        })}
        data-permission-key=${key}
      >
        <div class="approval-request__details">
          <div class="approval-request__path">
            ${data.relativePath || data.path}
          </div>
          <div class="approval-request__meta">
            ${data.sourceTool ? `Requested by ${data.sourceTool}` : ''}
            ${data.sourceTool && diffMeta ? html`<span>•</span>` : nothing}
            ${diffMeta}
          </div>
        </div>
        <div class="approval-request__actions">
          ${this.renderToolEditDiffActions(permission)}
          <vscode-toolbar-button
            data-action="reject"
            data-permission-kind=${permission.kind}
            data-permission-id=${this.getPermissionId(permission)}
            label=${isFeedbackOpen ? 'Submit' : 'Reject'}
            title=${isFeedbackOpen ? 'Submit rejection' : 'Reject'}
          ></vscode-toolbar-button>
          <vscode-toolbar-button
            data-action="approve"
            data-permission-kind=${permission.kind}
            data-permission-id=${this.getPermissionId(permission)}
            label="Approve"
            title="Approve"
          ></vscode-toolbar-button>
        </div>
        ${this.renderFeedbackSection(
          permission,
          'approval-request__feedback',
          'approval-request__feedback-input',
          'Why are you rejecting?',
        )}
      </div>
    `;
  }

  private renderToolEditDiffActions(
    permission: PermissionState,
  ): TemplateResult {
    const data = permission.data as ToolEditPermission;
    const key = this.getPermissionKey(permission);
    const isMenuOpen = this.openDiffMenuKey === key;
    const showDropdown = Boolean(data.isLatex);

    return html`
      <div class="diff-dropdown">
        <vscode-toolbar-button
          class="diff-main-button"
          data-action="openDiff"
          data-permission-kind=${permission.kind}
          data-permission-id=${this.getPermissionId(permission)}
          label="Diff"
          title="Diff"
        ></vscode-toolbar-button>
        ${showDropdown
          ? html`
              <vscode-toolbar-button
                class="diff-dropdown-trigger"
                aria-haspopup="true"
                aria-expanded=${isMenuOpen ? 'true' : 'false'}
                label="More diff actions"
                title="More diff actions"
                @click=${(event: MouseEvent) => this.toggleDiffMenu(event, key)}
              >
                <i class="codicon codicon-chevron-down"></i>
              </vscode-toolbar-button>
              <vscode-context-menu
                class="diff-dropdown-menu"
                ?show=${isMenuOpen}
                @vsc-click=${this.handleMenuClick}
              >
                <vscode-context-menu-item
                  value="previewProposed"
                  data-permission-kind=${permission.kind}
                  data-permission-id=${this.getPermissionId(permission)}
                >
                  Preview
                </vscode-context-menu-item>
                <vscode-context-menu-item
                  value="showLatexdiff"
                  data-permission-kind=${permission.kind}
                  data-permission-id=${this.getPermissionId(permission)}
                >
                  LaTeXdiff
                </vscode-context-menu-item>
              </vscode-context-menu>
            `
          : nothing}
      </div>
    `;
  }

  private renderBashRequest(permission: PermissionState): TemplateResult {
    const data = permission.data as BashPermission;
    return html`
      <div class="bash-approval-request">
        <div class="bash-approval-request__details">
          <div class="bash-approval-request__command">
            <code>${data.command ?? ''}</code>
          </div>
        </div>
        <div class="bash-approval-request__actions">
          <vscode-toolbar-button
            data-action="reject"
            data-permission-kind=${permission.kind}
            data-permission-id=${this.getPermissionId(permission)}
            label="Reject"
            title="Reject"
          ></vscode-toolbar-button>
          <vscode-toolbar-button
            data-action="approve"
            data-permission-kind=${permission.kind}
            data-permission-id=${this.getPermissionId(permission)}
            label="Approve"
            title="Approve"
          ></vscode-toolbar-button>
        </div>
      </div>
    `;
  }

  private renderRetryRequest(permission: PermissionState): TemplateResult {
    const data = permission.data as RetryPermission;
    const isRelay = data.errorDetails?.isRelayError === true;
    const retryable = data.errorDetails?.retryable !== false;
    const metaParts = [
      data.model ? `Model: ${data.model}` : null,
      isRelay ? 'Source: Relay' : null,
      `Retryable: ${retryable ? 'Yes' : 'No'}`,
    ].filter(Boolean);

    const detailsText = this.formatRetryDetails(data.errorDetails);

    return html`
      <div
        class=${classMap({
          'retry-request': true,
          'retry-request--relay': isRelay,
        })}
      >
        <div class="retry-request__details">
          <div class="retry-request__operation">
            ${isRelay ? '[Relay] ' : ''}
            ${data.operation ? `Failed: ${data.operation}` : 'Request failed'}
          </div>
          <div class="retry-request__meta">${metaParts.join(' \u2022 ')}</div>
          ${when(
            data.errorMessage,
            () =>
              html`<div class="retry-request__error">
                ${data.errorMessage}
              </div>`,
          )}
          ${detailsText
            ? html`
                <details class="retry-request__error-details">
                  <summary class="retry-request__error-summary">
                    <i class="codicon codicon-chevron-right toggle-icon"></i>
                    Error details
                  </summary>
                  <div class="retry-request__error-body">${detailsText}</div>
                </details>
              `
            : nothing}
        </div>
        <div class="retry-request__actions">
          <vscode-toolbar-button
            data-action="retry"
            data-permission-kind=${permission.kind}
            data-permission-id=${this.getPermissionId(permission)}
            label="Retry"
            title="Retry"
          ></vscode-toolbar-button>
          <vscode-toolbar-button
            data-action="dismiss"
            data-permission-kind=${permission.kind}
            data-permission-id=${this.getPermissionId(permission)}
            label="Dismiss"
            title="Dismiss"
          ></vscode-toolbar-button>
        </div>
      </div>
    `;
  }

  private renderProposalRequest(permission: PermissionState): TemplateResult {
    const data = permission.data as AgentProposalPermission;
    const key = this.getPermissionKey(permission);
    const isFeedbackOpen = this.feedbackOpenKeys.has(key);
    const isWorkflow = data.agentCategory === AGENT_CATEGORY.WORKFLOW;
    const categoryLabel = isWorkflow ? 'Workflow' : 'Tool-Use';

    return html`
      <div
        class=${classMap({
          'workflow-proposal': true,
          'workflow-proposal--feedback-active': isFeedbackOpen,
        })}
      >
        <div class="workflow-proposal__details">
          <div class="workflow-proposal__header-row">
            <span
              class=${classMap({
                'workflow-proposal__category-badge': true,
                'workflow-proposal__category-badge--workflow': isWorkflow,
                'workflow-proposal__category-badge--tool-use': !isWorkflow,
              })}
            >
              ${categoryLabel}
            </span>
            <span class="workflow-proposal__agent">${data.agent}</span>
            <span class="workflow-proposal__model">${data.model}</span>
          </div>
          <div class="workflow-proposal__instruction">${data.instruction}</div>
          ${isWorkflow
            ? html`<div class="workflow-proposal__files">
                ${this.renderProposalFiles(
                  data as WorkflowAgentProposalPermission,
                )}
              </div>`
            : nothing}
        </div>
        <div class="workflow-proposal__actions">
          <vscode-toolbar-button
            data-action="reject"
            data-permission-kind=${permission.kind}
            data-permission-id=${this.getPermissionId(permission)}
            label=${isFeedbackOpen ? 'Submit' : 'Reject'}
            title=${isFeedbackOpen ? 'Submit rejection' : 'Reject'}
          ></vscode-toolbar-button>
          <vscode-toolbar-button
            data-action="setup"
            data-permission-kind=${permission.kind}
            data-permission-id=${this.getPermissionId(permission)}
            label="Setup"
            title="Setup"
          ></vscode-toolbar-button>
          <vscode-toolbar-button
            data-action="approve"
            data-permission-kind=${permission.kind}
            data-permission-id=${this.getPermissionId(permission)}
            label="Approve"
            title="Approve"
          ></vscode-toolbar-button>
        </div>
        ${this.renderFeedbackSection(
          permission,
          'workflow-proposal__feedback',
          'workflow-proposal__feedback-input',
          'Why are you rejecting?',
        )}
      </div>
    `;
  }

  private renderProposalFiles(
    permission: WorkflowAgentProposalPermission,
  ): TemplateResult | typeof nothing {
    const combine = (single: string | null | undefined, arr: string[] = []) =>
      [single, ...arr].filter((f): f is string => Boolean(f));

    const fileLists = [
      {
        label: 'Input',
        files: combine(permission.inputFile, permission.inputFiles),
      },
      {
        label: 'Reference',
        files: combine(permission.referenceFile, permission.referenceFiles),
      },
      {
        label: 'Auxiliary',
        files: combine(permission.auxiliaryFile, permission.auxiliaryFiles),
      },
      {
        label: 'Media',
        files: combine(permission.mediaFile, permission.mediaFiles),
      },
      { label: 'Output', files: permission.outputFiles ?? [] },
    ];

    return html`${repeat(
      fileLists,
      ({ label }) => label,
      ({ label, files }) => this.renderProposalFileList(label, files),
    )}`;
  }

  private renderProposalFileList(
    label: string,
    files: string[],
  ): TemplateResult | typeof nothing {
    if (files.length === 0) return nothing;

    return html`
      <div class="workflow-proposal__${label.toLowerCase()}-files">
        <span class="workflow-proposal__file-label">${label}:</span>
        ${repeat(
          files,
          (file) => file,
          (file, i) =>
            html`${i > 0 ? ', ' : ''}<span
                class="workflow-proposal__file-name"
                title=${file}
                @click=${() => this.openFile(file)}
                >${getBasename(file)}</span
              >`,
        )}
      </div>
    `;
  }

  private renderFeedbackSection(
    permission: PermissionState,
    containerClass: string,
    inputClass: string,
    placeholder: string,
  ): TemplateResult | typeof nothing {
    const key = this.getPermissionKey(permission);
    if (
      !this.feedbackOpenKeys.has(key) ||
      !FEEDBACK_KINDS.has(permission.kind)
    ) {
      return nothing;
    }

    return html`
      <div class=${containerClass}>
        <vscode-textarea
          class=${inputClass}
          placeholder=${placeholder}
          rows="3"
          data-feedback-for=${key}
        ></vscode-textarea>
      </div>
    `;
  }

  private renderToolEditDiffMeta(
    request: ToolEditPermission,
  ): TemplateResult | typeof nothing {
    const toCount = (value: number | undefined): number => {
      if (value === undefined || !Number.isFinite(value)) return 0;
      return Math.max(0, value);
    };
    const added = toCount(request.addedLines);
    const removed = toCount(request.removedLines);
    const total = added + removed;
    const lineLabel = total === 1 ? 'line' : 'lines';
    const tooltip = this.buildDiffTooltip(added, removed, lineLabel);

    return html`
      <span class="approval-request__diff" title=${tooltip}>
        ${when(
          added > 0,
          () =>
            html`<span class="approval-request__diff-added">+${added}</span>`,
        )}
        ${when(
          removed > 0,
          () =>
            html`<span class="approval-request__diff-removed"
              >-${removed}</span
            >`,
        )}
        <span class="approval-request__diff-label">${total} ${lineLabel}</span>
      </span>
    `;
  }

  // ===========================================================================
  // Event handlers
  // ===========================================================================

  private handleActionClick = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    if (!target) return;

    const actionEl = target.closest<HTMLElement>(
      '[data-action][data-permission-kind][data-permission-id]',
    );
    if (!actionEl) return;

    const action = actionEl.dataset.action;
    const kind = actionEl.dataset.permissionKind as
      | PermissionState['kind']
      | undefined;
    const permissionId = actionEl.dataset.permissionId;
    if (!action || !kind || !permissionId) return;

    const permission = this.permissions.find(
      (item) => item.kind === kind && this.getPermissionId(item) === permissionId,
    );
    if (!permission) return;

    const key = this.getPermissionKey(permission);
    if (action === 'reject' && FEEDBACK_KINDS.has(kind)) {
      if (!this.feedbackOpenKeys.has(key)) {
        this.openFeedback(key);
        return;
      }

      const feedback = this.getFeedbackValue(key);
      this.closeFeedback(key);
      this.emitAction(permission, action, feedback);
      return;
    }

    if (action === 'dismiss') {
      this.emitAction(permission, 'cancel');
      return;
    }

    this.emitAction(permission, action);
  };

  private handleMenuClick = (event: CustomEvent): void => {
    const target = event.target as Element | null;
    if (!target) return;

    const menuItem = target.closest('vscode-context-menu-item');
    if (!menuItem) return;

    const kind = menuItem.dataset.permissionKind as
      | PermissionState['kind']
      | undefined;
    const permissionId = menuItem.dataset.permissionId;
    const action = event.detail?.value ?? menuItem.getAttribute('value') ?? '';
    if (!kind || !permissionId || !action) return;

    const permission = this.permissions.find(
      (item) =>
        item.kind === kind && this.getPermissionId(item) === permissionId,
    );
    if (!permission) return;

    this.openDiffMenuKey = null;
    this.emitAction(permission, action);
  };

  private handleOutsideClick = (event: MouseEvent): void => {
    if (!this.openDiffMenuKey) return;

    const path = event.composedPath?.() ?? [];
    const clickedInside = path.some(
      (node) =>
        node instanceof Element &&
        (node.classList.contains('diff-dropdown') ||
          node.classList.contains('diff-dropdown-menu')),
    );
    if (!clickedInside) {
      this.openDiffMenuKey = null;
    }
  };

  private toggleDiffMenu(event: MouseEvent, key: PermissionKey): void {
    event.stopPropagation();
    this.openDiffMenuKey = this.openDiffMenuKey === key ? null : key;
  }

  private openFeedback(key: PermissionKey): void {
    const next = new Set(this.feedbackOpenKeys);
    next.add(key);
    this.feedbackOpenKeys = next;

    this.updateComplete.then(() => {
      const input = this.renderRoot.querySelector<HTMLElement>(
        `[data-feedback-for="${key}"]`,
      );
      input?.focus();
    });
  }

  private closeFeedback(key: PermissionKey): void {
    const next = new Set(this.feedbackOpenKeys);
    next.delete(key);
    this.feedbackOpenKeys = next;
  }

  private getFeedbackValue(key: PermissionKey): string | undefined {
    const input = this.renderRoot.querySelector<HTMLElement>(
      `[data-feedback-for="${key}"]`,
    ) as HTMLElement & { value?: string };
    const raw = input?.value ?? '';
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private getPermissionId(permission: PermissionState): string {
    switch (permission.kind) {
      case PERMISSION_KIND.RETRY:
        return permission.data.streamId;
      case PERMISSION_KIND.PROPOSAL:
        return permission.data.proposalId;
      default:
        return permission.data.requestId;
    }
  }

  private getPermissionKey(permission: PermissionState): PermissionKey {
    return `${permission.kind}:${this.getPermissionId(permission)}`;
  }

  private openFile(filePath: string): void {
    postMessage(PROGRESS_VIEW_COMMANDS.OPEN_FILE, { file: filePath });
  }

  private emitAction(
    permission: PermissionState,
    action: string,
    feedback?: string,
  ): void {
    this.dispatchEvent(
      ProgressEvents.permissionAction({ permission, action, feedback }),
    );
  }

  private buildDiffTooltip(
    added: number,
    removed: number,
    lineLabel: string,
  ): string {
    if (added === 0 && removed === 0) {
      return 'No line changes';
    }
    const parts: string[] = [];
    if (added > 0) parts.push(`+${added}`);
    if (removed > 0) parts.push(`-${removed}`);
    return `${parts.join(' / ')} ${lineLabel} changed`;
  }

  private formatRetryDetails(
    details: ProviderErrorPartial | undefined,
  ): string | null {
    if (!details) return null;

    const formatBody = (body: unknown) =>
      typeof body === 'object' ? JSON.stringify(body, null, 2) : String(body);

    const lines = [
      details.message && `message: ${details.message}`,
      details.provider && `provider: ${details.provider}`,
      details.statusCode != null && `statusCode: ${details.statusCode}`,
      details.statusText && `statusText: ${details.statusText}`,
      details.isRelayError != null && `isRelayError: ${details.isRelayError}`,
      details.retryable != null && `retryable: ${details.retryable}`,
      details.requestId && `requestId: ${details.requestId}`,
      details.rawErrorBody != null &&
        `rawErrorBody: ${formatBody(details.rawErrorBody)}`,
    ].filter(Boolean);

    if (details.streamDiagnostics) {
      const diag = details.streamDiagnostics;
      lines.push('--- Stream Diagnostics ---');
      lines.push(`  thinkingChars: ${diag.thinkingChars}`);
      lines.push(`  textChars: ${diag.textChars}`);
      lines.push(`  toolInputChars: ${diag.toolInputChars}`);
      lines.push(
        `  blockTypesSeen: [${diag.blockTypesSeen?.join(', ') || ''}]`,
      );
      lines.push(`  eventsProcessed: ${diag.eventsProcessed}`);
      lines.push(`  lastEventType: ${diag.lastEventType ?? 'null'}`);
      lines.push(`  elapsedSecs: ${diag.elapsedSecs}`);
      lines.push(`  secsSinceLastEvent: ${diag.secsSinceLastEvent}`);
      lines.push(`  finalized: ${diag.finalized}`);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'request-panels': RequestPanels;
  }
}
