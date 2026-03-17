/**
 * Individual panel component for agent proposal requests.
 *
 * Renders a single proposal permission with agent/model details,
 * workflow file lists, model selection dropdown, approve/reject/setup
 * buttons, and feedback input.
 *
 * Extends BaseFeedbackPanel for shared feedback/reject/emit logic.
 */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import {
  codiconIconClasses,
  commonViewStyles,
  designTokens,
  requestPanelStyles,
  selectStyles,
} from '@shared/styles';

// Local imports - shared utils
import { AGENT_CATEGORY, type AgentProposalPermission } from '@shared/schemas';
import { postMessage } from '@shared/vscode';
import { renderModelOptions } from '@shared/utils/selectTemplates';

// Local imports - shared schemas
import { getProposalFileGroups } from '@shared/schemas/proposalFields';

// Local imports - shared utilities
import { getBasename } from '@shared/utils/path';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

// Local imports - base class
import { BaseFeedbackPanel } from './BaseFeedbackPanel';

@customElement('proposal-request-panel')
export class ProposalRequestPanel extends BaseFeedbackPanel {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconIconClasses,
    requestPanelStyles,
    selectStyles,
  ];

  @state() private selectedModel: string | null = null;

  protected override handleExtraKey(key: string): boolean {
    if (key === 's') {
      this.emitAction('setup');
      return true;
    }
    return false;
  }

  override render(): TemplateResult {
    const data = this.permission.data as AgentProposalPermission;
    const modelOptions =
      this.permission.kind === PERMISSION_KIND.PROPOSAL
        ? (this.permission.modelOptions ?? [])
        : [];
    const isWorkflow = data.agentCategory === AGENT_CATEGORY.WORKFLOW;
    const categoryLabel = isWorkflow ? 'Workflow' : 'Tool-Use';
    const currentModel = this.selectedModel ?? data.model;
    const hasModelOptions = modelOptions.length > 0;

    return html`
      <div
        class=${classMap({
          'workflow-proposal': true,
          'workflow-proposal--feedback-active': this.showFeedback,
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
            ${hasModelOptions
              ? html`
                  <div class="workflow-proposal__model-select">
                    <i class="codicon codicon-robot"></i>
                    <vscode-single-select
                      class="proposal-model-dropdown"
                      position="below"
                      .value=${currentModel}
                      @change=${this.handleSelectChange}
                    >
                      ${renderModelOptions(modelOptions, currentModel)}
                    </vscode-single-select>
                  </div>
                `
              : html`<span class="workflow-proposal__model"
                  >${data.model}</span
                >`}
          </div>
          <div class="workflow-proposal__instruction">${data.instruction}</div>
          ${this.renderProposalFiles(data)}
        </div>
        <vscode-toolbar-container class="workflow-proposal__actions">
          <vscode-toolbar-button
            icon="check"
            label="Approve"
            title="Approve (y)"
            @click=${() => this.emitAction('approve')}
            >Approve</vscode-toolbar-button
          >
          ${this.renderRejectButton('Reject (n)')}
          <vscode-toolbar-button
            icon="reply"
            label="Setup"
            title="Setup (s)"
            @click=${() => this.emitAction('setup')}
            >Setup</vscode-toolbar-button
          >
        </vscode-toolbar-container>
        ${this.renderFeedbackSection(
          'workflow-proposal__feedback',
          'workflow-proposal__feedback-input',
        )}
      </div>
    `;
  }

  // ===========================================================================
  // Proposal-specific rendering
  // ===========================================================================

  private renderProposalFiles(
    data: AgentProposalPermission,
  ): TemplateResult | typeof nothing {
    const groups = getProposalFileGroups(data);
    if (groups.length === 0) return nothing;
    return html`<div class="workflow-proposal__files">
      ${repeat(
        groups,
        ({ label }) => label,
        ({ label, files, clickable }) =>
          this.renderProposalFileList(label, files, clickable),
      )}
    </div>`;
  }

  private renderProposalFileList(
    label: string,
    files: string[],
    clickable: boolean,
  ): TemplateResult | typeof nothing {
    if (files.length === 0) return nothing;

    return html`
      <div
        class="workflow-proposal__${label.toLowerCase()}-files"
        @click=${this.handleFileClick}
      >
        <span class="workflow-proposal__file-label">${label}:</span>
        ${repeat(
          files,
          (file) => file,
          (file, i) =>
            html`${i > 0 ? ', ' : ''}<span
                class="workflow-proposal__file-name${clickable
                  ? ''
                  : ' workflow-proposal__file-name--readonly'}"
                title=${file}
                data-file=${ifDefined(clickable ? file : undefined)}
                >${getBasename(file)}</span
              >`,
        )}
      </div>
    `;
  }

  // ===========================================================================
  // Proposal-specific handlers
  // ===========================================================================

  private handleFileClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    const file = target.dataset?.file;
    if (file) {
      postMessage(PROGRESS_VIEW_COMMANDS.OPEN_FILE, { file });
    }
  };

  private handleSelectChange = (event: Event): void => {
    const value = (event.target as HTMLSelectElement).value;
    if (value) {
      this.selectedModel = value;
    }
  };

  // ===========================================================================
  // Override emitAction to include model override for approve
  // ===========================================================================

  protected override emitAction(action: string, feedback?: string): void {
    const modelOverride =
      action === 'approve' ? this.getModelOverride() : undefined;
    super.emitAction(action, feedback, modelOverride);
  }

  private getModelOverride(): string | undefined {
    const data = this.permission.data as AgentProposalPermission;
    return this.selectedModel && this.selectedModel !== data.model
      ? this.selectedModel
      : undefined;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'proposal-request-panel': ProposalRequestPanel;
  }
}
