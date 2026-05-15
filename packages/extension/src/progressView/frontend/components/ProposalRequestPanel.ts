/** Agent proposal request panel. */

// Third-party imports
import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';

// Local imports - shared styles
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import {
  commonViewStyles,
  designTokens,
  requestPanelStyles,
  selectStyles,
} from '@shared/styles';

// Local imports - shared utils
import {
  AGENT_CATEGORY,
  type AgentProposalPermission,
  type WorkflowAgentProposalPermission,
} from '@shared/schemas';
import { postMessage } from '@shared/hostBridge';
import { markdownStyles } from '@shared/styles/markdownStyles';
import {
  renderAgentOptions,
  renderModelOptions,
} from '@shared/utils/selectTemplates';

// Local imports - shared schemas
import { getProposalFileGroups } from '@shared/schemas/proposalFields';

// Local imports - shared utilities
import { getBasename } from '@shared/utils/path';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';

// Local imports - base class
import { BaseFeedbackPanel } from './BaseFeedbackPanel';
import { processMarkdownContent } from '../formatters/markdownRenderer';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';
import type { PermissionState } from './PermissionCard';

function proposalIdOf(
  p: PermissionState | null | undefined,
): string | undefined {
  return p?.kind === PERMISSION_KIND.PROPOSAL ? p.data.proposalId : undefined;
}

@customElement('proposal-request-panel')
export class ProposalRequestPanel extends BaseFeedbackPanel {
  static override styles = [
    designTokens,
    commonViewStyles,
    markdownStyles,
    requestPanelStyles,
    selectStyles,
  ];

  @state() private selectedModel: string | null = null;
  @state() private selectedAgent: string | null = null;

  // Reset selections only when the proposal's identity changes, so an async
  // permission upsert that just adds dropdown options doesn't wipe the user's
  // in-progress pick for the same proposal.
  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (!changed.has('permission')) return;
    const previous = changed.get('permission') as
      | PermissionState
      | null
      | undefined;
    if (proposalIdOf(previous) !== proposalIdOf(this.permission)) {
      this.selectedModel = null;
      this.selectedAgent = null;
    }
  }

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
    const agentOptions =
      this.permission.kind === PERMISSION_KIND.PROPOSAL
        ? (this.permission.agentOptions ?? [])
        : [];
    const isWorkflow = data.agentCategory === AGENT_CATEGORY.WORKFLOW;
    const categoryLabel = isWorkflow ? 'Workflow' : 'Tool-Use';
    const currentModel = this.selectedModel ?? data.model;
    const currentAgent = this.selectedAgent ?? data.agent;
    const hasModelOptions = modelOptions.length > 0;
    const hasAgentOptions = agentOptions.length > 0;

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
            ${hasAgentOptions
              ? html`
                  <div class="workflow-proposal__agent-select">
                    <wa-icon
                      library="texra"
                      name="sparkle"
                      aria-hidden="true"
                    ></wa-icon>
                    <wa-select
                      class="proposal-agent-dropdown"
                      .value=${currentAgent}
                      @change=${this.handleAgentSelectChange}
                    >
                      ${renderAgentOptions(agentOptions, currentAgent)}
                    </wa-select>
                  </div>
                `
              : html`<span class="workflow-proposal__agent"
                  >${data.agent}</span
                >`}
            ${hasModelOptions
              ? html`
                  <div class="workflow-proposal__model-select">
                    <wa-icon
                      library="texra"
                      name="robot"
                      aria-hidden="true"
                    ></wa-icon>
                    <wa-select
                      class="proposal-model-dropdown"
                      .value=${currentModel}
                      @change=${this.handleSelectChange}
                    >
                      ${renderModelOptions(modelOptions, currentModel)}
                    </wa-select>
                  </div>
                `
              : html`<span class="workflow-proposal__model"
                  >${data.model}</span
                >`}
          </div>
          ${this.renderInstruction(data.instruction)}
          ${isWorkflow ? this.renderExtractFlags(data) : nothing}
          ${this.renderProposalFiles(data)}
        </div>
        <div class="workflow-proposal__actions">
          ${renderLabeledActionButton({
            icon: 'check',
            text: 'Approve',
            title: 'Approve (y)',
            action: 'approve',
            onClick: () => this.emitAction('approve'),
          })}
          ${this.renderRejectButton('Reject (n)')}
          ${renderLabeledActionButton({
            icon: 'reply',
            text: 'Setup',
            title: 'Setup (s)',
            action: 'setup',
            onClick: () => this.emitAction('setup'),
          })}
        </div>
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

  private renderInstruction(instruction: string): TemplateResult {
    const markdownHtml = processMarkdownContent(instruction);
    return html`<div class="workflow-proposal__instruction markdown-content">
      ${unsafeHTML(markdownHtml)}
    </div>`;
  }

  private renderWorkingDirectory(
    data: AgentProposalPermission,
  ): TemplateResult | typeof nothing {
    const workingDirectory = data.workingDirectory;
    if (!workingDirectory) return nothing;
    return html`<div
      class="workflow-proposal__working-directory"
      title=${workingDirectory}
    >
      <span class="workflow-proposal__file-label">Working directory:</span>
      <span
        class="workflow-proposal__file-name workflow-proposal__file-name--readonly workflow-proposal__file-name--wrap"
        >${workingDirectory}</span
      >
    </div>`;
  }

  private renderProposalFiles(
    data: AgentProposalPermission,
  ): TemplateResult | typeof nothing {
    const groups = getProposalFileGroups(data);
    const workingDirectoryRow = this.renderWorkingDirectory(data);
    if (groups.length === 0 && workingDirectoryRow === nothing) return nothing;
    return html`<div class="workflow-proposal__files">
      ${workingDirectoryRow}
      ${repeat(
        groups,
        ({ label }) => label,
        ({ label, files, clickable }) =>
          this.renderProposalFileList(label, files, clickable),
      )}
    </div>`;
  }

  private renderExtractFlags(
    data: WorkflowAgentProposalPermission,
  ): TemplateResult | typeof nothing {
    const flags: string[] = [];
    if (data.toolConfig.autoExtractFigure) flags.push('Extract Figures');
    if (data.toolConfig.autoExtractTikzFigure) flags.push('Extract TikZ');
    if (flags.length === 0) return nothing;
    return html`<div class="workflow-proposal__extract-flags">
      ${repeat(
        flags,
        (flag) => flag,
        (flag) =>
          html`<span
            class="workflow-proposal__category-badge workflow-proposal__category-badge--workflow workflow-proposal__extract-flag"
            ><wa-icon
              library="texra"
              name="file-media"
              aria-hidden="true"
            ></wa-icon>
            ${flag}</span
          >`,
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
    const file = (event.target as HTMLElement).dataset.file;
    if (file) {
      postMessage(PROGRESS_VIEW_COMMANDS.OPEN_FILE, { file });
    }
  };

  private handleSelectChange = (event: Event): void => {
    // Read from currentTarget (the wa-select host) instead of target — wa-select
    // can retarget events from internal elements, and HTMLSelectElement is the
    // wrong type for this Web Component anyway.
    const select = event.currentTarget as WaSelect | null;
    const value = typeof select?.value === 'string' ? select.value : '';
    if (value) {
      this.selectedModel = value;
    }
  };

  private handleAgentSelectChange = (event: Event): void => {
    const select = event.currentTarget as WaSelect | null;
    const value = typeof select?.value === 'string' ? select.value : '';
    if (value) {
      this.selectedAgent = value;
    }
  };

  // ===========================================================================
  // Override emitAction to include model/agent overrides for approve
  // ===========================================================================

  protected override emitAction(action: string, feedback?: string): void {
    if (action !== 'approve') {
      super.emitAction(action, feedback);
      return;
    }
    const data = this.permission.data as AgentProposalPermission;
    const pickIfChanged = (
      selected: string | null,
      original: string,
    ): string | undefined =>
      selected && selected !== original ? selected : undefined;
    super.emitAction(
      action,
      feedback,
      pickIfChanged(this.selectedModel, data.model),
      pickIfChanged(this.selectedAgent, data.agent),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'proposal-request-panel': ProposalRequestPanel;
  }
}
