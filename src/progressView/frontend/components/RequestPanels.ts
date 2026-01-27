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
import type {
  AgentProposalPrompt,
  ProviderErrorPartial,
  RetryRequestPrompt,
  ToolEditApprovalPrompt,
  WorkflowAgentProposalPrompt,
} from '@shared/schemas';
import { AGENT_CATEGORY } from '@shared/schemas';

// Local imports - shared utilities
import { getBasename } from '@shared/utils/path';
import { postMessage } from '@shared/vscode';

// Local imports - webview commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view events
import { ProgressEvents } from '../events';

// Local imports - progress view component types
import type { PromptState } from './PromptOverlay';

const FEEDBACK_KINDS = new Set<PromptState['kind']>(['toolEdit', 'proposal']);

type PromptKey = string;

@customElement('request-panels')
export class RequestPanels extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconIconClasses,
    requestPanelStyles,
  ];

  @property({ type: Array }) prompts: PromptState[] = [];

  @state() private feedbackOpenKeys: Set<PromptKey> = new Set();
  @state() private openDiffMenuKey: PromptKey | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('click', this.handleOutsideClick, true);
  }

  override disconnectedCallback(): void {
    document.removeEventListener('click', this.handleOutsideClick, true);
    super.disconnectedCallback();
  }

  override render(): TemplateResult | typeof nothing {
    const approvals = this.prompts.filter((p) => p.kind === 'toolEdit');
    const bashApprovals = this.prompts.filter((p) => p.kind === 'bash');
    const retries = this.prompts.filter((p) => p.kind === 'retry');
    const proposals = this.prompts.filter((p) => p.kind === 'proposal');

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
    prompts: PromptState[],
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
            (prompt) => this.getPromptKey(prompt),
            (prompt) => this.renderToolEditRequest(prompt),
          )}
        </div>
      </section>
    `;
  }

  private renderBashSection(
    prompts: PromptState[],
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
            (prompt) => this.getPromptKey(prompt),
            (prompt) => this.renderBashRequest(prompt),
          )}
        </div>
      </section>
    `;
  }

  private renderRetrySection(
    prompts: PromptState[],
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
            (prompt) => this.getPromptKey(prompt),
            (prompt) => this.renderRetryRequest(prompt),
          )}
        </div>
      </section>
    `;
  }

  private renderProposalSection(
    prompts: PromptState[],
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
            (prompt) => this.getPromptKey(prompt),
            (prompt) => this.renderProposalRequest(prompt),
          )}
        </div>
      </section>
    `;
  }

  // ===========================================================================
  // Individual request renderers
  // ===========================================================================

  private renderToolEditRequest(prompt: PromptState): TemplateResult {
    const data = prompt.data as ToolEditApprovalPrompt;
    const key = this.getPromptKey(prompt);
    const isFeedbackOpen = this.feedbackOpenKeys.has(key);
    const diffMeta = this.renderToolEditDiffMeta(data);

    return html`
      <div
        class=${classMap({
          'approval-request': true,
          'approval-request--feedback-active': isFeedbackOpen,
        })}
        data-prompt-key=${key}
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
          ${this.renderToolEditDiffActions(prompt)}
          <vscode-toolbar-button
            data-action="reject"
            data-prompt-kind=${prompt.kind}
            data-prompt-id=${this.getPromptId(prompt)}
            label=${isFeedbackOpen ? 'Submit' : 'Reject'}
            title=${isFeedbackOpen ? 'Submit rejection' : 'Reject'}
          ></vscode-toolbar-button>
          <vscode-toolbar-button
            data-action="approve"
            data-prompt-kind=${prompt.kind}
            data-prompt-id=${this.getPromptId(prompt)}
            label="Approve"
            title="Approve"
          ></vscode-toolbar-button>
        </div>
        ${this.renderFeedbackSection(
          prompt,
          'approval-request__feedback',
          'approval-request__feedback-input',
          'Why are you rejecting?',
        )}
      </div>
    `;
  }

  private renderToolEditDiffActions(prompt: PromptState): TemplateResult {
    const data = prompt.data as ToolEditApprovalPrompt;
    const key = this.getPromptKey(prompt);
    const isMenuOpen = this.openDiffMenuKey === key;
    const showDropdown = Boolean(data.isLatex);

    return html`
      <div class="diff-dropdown">
        <vscode-toolbar-button
          class="diff-main-button"
          data-action="openDiff"
          data-prompt-kind=${prompt.kind}
          data-prompt-id=${this.getPromptId(prompt)}
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
                  data-prompt-kind=${prompt.kind}
                  data-prompt-id=${this.getPromptId(prompt)}
                >
                  Preview
                </vscode-context-menu-item>
                <vscode-context-menu-item
                  value="showLatexdiff"
                  data-prompt-kind=${prompt.kind}
                  data-prompt-id=${this.getPromptId(prompt)}
                >
                  LaTeXdiff
                </vscode-context-menu-item>
              </vscode-context-menu>
            `
          : nothing}
      </div>
    `;
  }

  private renderBashRequest(prompt: PromptState): TemplateResult {
    const data = prompt.data as PromptState['data'] & { command?: string };
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
            data-prompt-kind=${prompt.kind}
            data-prompt-id=${this.getPromptId(prompt)}
            label="Reject"
            title="Reject"
          ></vscode-toolbar-button>
          <vscode-toolbar-button
            data-action="approve"
            data-prompt-kind=${prompt.kind}
            data-prompt-id=${this.getPromptId(prompt)}
            label="Approve"
            title="Approve"
          ></vscode-toolbar-button>
        </div>
      </div>
    `;
  }

  private renderRetryRequest(prompt: PromptState): TemplateResult {
    const data = prompt.data as RetryRequestPrompt;
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
          <div class="retry-request__meta">${metaParts.join(' • ')}</div>
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
            data-prompt-kind=${prompt.kind}
            data-prompt-id=${this.getPromptId(prompt)}
            label="Retry"
            title="Retry"
          ></vscode-toolbar-button>
          <vscode-toolbar-button
            data-action="dismiss"
            data-prompt-kind=${prompt.kind}
            data-prompt-id=${this.getPromptId(prompt)}
            label="Dismiss"
            title="Dismiss"
          ></vscode-toolbar-button>
        </div>
      </div>
    `;
  }

  private renderProposalRequest(prompt: PromptState): TemplateResult {
    const data = prompt.data as AgentProposalPrompt;
    const key = this.getPromptKey(prompt);
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
                ${this.renderProposalFiles(data as WorkflowAgentProposalPrompt)}
              </div>`
            : nothing}
        </div>
        <div class="workflow-proposal__actions">
          <vscode-toolbar-button
            data-action="reject"
            data-prompt-kind=${prompt.kind}
            data-prompt-id=${this.getPromptId(prompt)}
            label=${isFeedbackOpen ? 'Submit' : 'Reject'}
            title=${isFeedbackOpen ? 'Submit rejection' : 'Reject'}
          ></vscode-toolbar-button>
          <vscode-toolbar-button
            data-action="setup"
            data-prompt-kind=${prompt.kind}
            data-prompt-id=${this.getPromptId(prompt)}
            label="Setup"
            title="Setup"
          ></vscode-toolbar-button>
          <vscode-toolbar-button
            data-action="approve"
            data-prompt-kind=${prompt.kind}
            data-prompt-id=${this.getPromptId(prompt)}
            label="Approve"
            title="Approve"
          ></vscode-toolbar-button>
        </div>
        ${this.renderFeedbackSection(
          prompt,
          'workflow-proposal__feedback',
          'workflow-proposal__feedback-input',
          'Why are you rejecting?',
        )}
      </div>
    `;
  }

  private renderProposalFiles(
    prompt: WorkflowAgentProposalPrompt,
  ): TemplateResult | typeof nothing {
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
    prompt: PromptState,
    containerClass: string,
    inputClass: string,
    placeholder: string,
  ): TemplateResult | typeof nothing {
    const key = this.getPromptKey(prompt);
    if (!this.feedbackOpenKeys.has(key) || !FEEDBACK_KINDS.has(prompt.kind)) {
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
    request: ToolEditApprovalPrompt,
  ): TemplateResult | typeof nothing {
    const toCount = (value: number | undefined) =>
      Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
    const added = toCount(request.addedLines);
    const removed = toCount(request.removedLines);
    const total = added + removed;
    const lineLabel = total === 1 ? 'line' : 'lines';
    const tooltip =
      total > 0
        ? `${added > 0 ? `+${added}` : ''}${
            removed > 0 ? ` / -${removed}` : ''
          } ${lineLabel} changed`
        : 'No line changes';

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

  override firstUpdated(): void {
    this.addEventListener('click', this.handleActionClick);
  }

  private handleActionClick = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    if (!target) return;

    const actionEl = target.closest<HTMLElement>(
      '[data-action][data-prompt-kind][data-prompt-id]',
    );
    if (!actionEl) return;

    const action = actionEl.dataset.action;
    const kind = actionEl.dataset.promptKind as PromptState['kind'] | undefined;
    const promptId = actionEl.dataset.promptId;
    if (!action || !kind || !promptId) return;

    const prompt = this.prompts.find(
      (item) => item.kind === kind && this.getPromptId(item) === promptId,
    );
    if (!prompt) return;

    const key = this.getPromptKey(prompt);
    if (action === 'reject' && FEEDBACK_KINDS.has(kind)) {
      if (!this.feedbackOpenKeys.has(key)) {
        this.openFeedback(key);
        return;
      }

      const feedback = this.getFeedbackValue(key);
      this.closeFeedback(key);
      this.emitAction(prompt, action, feedback);
      return;
    }

    if (action === 'dismiss') {
      this.emitAction(prompt, 'cancel');
      return;
    }

    this.emitAction(prompt, action);
  };

  private handleMenuClick = (event: CustomEvent): void => {
    const target = event.target as Element | null;
    if (!target) return;

    const menuItem = target.closest('vscode-context-menu-item');
    if (!menuItem) return;

    const kind = menuItem.dataset.promptKind as PromptState['kind'] | undefined;
    const promptId = menuItem.dataset.promptId;
    const action = event.detail?.value ?? menuItem.getAttribute('value') ?? '';
    if (!kind || !promptId || !action) return;

    const prompt = this.prompts.find(
      (item) => item.kind === kind && this.getPromptId(item) === promptId,
    );
    if (!prompt) return;

    this.openDiffMenuKey = null;
    this.emitAction(prompt, action);
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

  private toggleDiffMenu(event: MouseEvent, key: PromptKey): void {
    event.stopPropagation();
    this.openDiffMenuKey = this.openDiffMenuKey === key ? null : key;
  }

  private openFeedback(key: PromptKey): void {
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

  private closeFeedback(key: PromptKey): void {
    const next = new Set(this.feedbackOpenKeys);
    next.delete(key);
    this.feedbackOpenKeys = next;
  }

  private getFeedbackValue(key: PromptKey): string | undefined {
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

  private getPromptId(prompt: PromptState): string {
    switch (prompt.kind) {
      case 'retry':
        return prompt.data.streamId;
      case 'proposal':
        return prompt.data.proposalId;
      default:
        return prompt.data.requestId;
    }
  }

  private getPromptKey(prompt: PromptState): PromptKey {
    return `${prompt.kind}:${this.getPromptId(prompt)}`;
  }

  private openFile(filePath: string): void {
    postMessage(PROGRESS_VIEW_COMMANDS.OPEN_FILE, { file: filePath });
  }

  private emitAction(
    prompt: PromptState,
    action: string,
    feedback?: string,
  ): void {
    this.dispatchEvent(
      ProgressEvents.promptAction({ prompt, action, feedback }),
    );
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
