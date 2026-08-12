/** Agent proposal request panel. */

// Third-party imports
import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  commonViewStyles,
  designTokens,
  requestPanelSharedStyles,
  selectStyles,
} from '@shared/styles';

// Local imports - shared utils
import {
  AgentCategory,
  type AgentProposalPermission,
  type WorkflowAgentProposalPermission,
} from '@shared/schemas';
import { postMessage } from '@shared/hostBridge';
import { markdownStyles } from '@shared/styles/markdownStyles';
import {
  readSelectValue,
  renderAgentOptions,
  renderModelOptions,
} from '@shared/utils/selectTemplates';

// Local imports - shared schemas
import { getProposalFileGroups } from '@shared/schemas/proposalFields';

// Local imports - shared utilities
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { getBasename } from '@utils/core';

// Local imports - base class
import { BaseApprovalPanel } from './BaseApprovalPanel';
import { proposalRequestPanelStyles } from './ProposalRequestPanel.styles';
import { APPROVE_ALL_DELEGATED_WORK_ACTION } from '../events';
import { processMarkdownContent } from '../formatters/markdownRenderer';
import { getComposedPathElement } from '../utils';
import type { PermissionState } from '../permissionState';

function proposalIdOf(
  p: PermissionState | null | undefined,
): string | undefined {
  return p?.kind === PERMISSION_KIND.PROPOSAL ? p.data.proposalId : undefined;
}

@customElement('proposal-request-panel')
export class ProposalRequestPanel extends BaseApprovalPanel<'proposal'> {
  static override styles = [
    designTokens,
    commonViewStyles,
    markdownStyles,
    requestPanelSharedStyles,
    proposalRequestPanelStyles,
    selectStyles,
  ];

  @state() private selectedModel: string | null = null;
  @state() private selectedAgent: string | null = null;

  protected get approvalDecision() {
    return { action: 'approve' as const, ...this.proposalOverrides };
  }

  // Reset selections only when the proposal's identity changes, so an async
  // permission upsert that just adds dropdown options doesn't wipe the user's
  // in-progress pick for the same proposal.
  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (!changed.has('permission')) return;
    const previous = changed.get('permission') as
      PermissionState | null | undefined;
    if (proposalIdOf(previous) !== proposalIdOf(this.permission)) {
      this.selectedModel = null;
      this.selectedAgent = null;
    }
  }

  protected override handleExtraKey(key: string): boolean {
    switch (key) {
      case 's':
        this.emitAction({ action: 'setup' });
        return true;
      default:
        return false;
    }
  }

  // Proposals carry a stronger approval action than the edit/bash bypass.
  // Enabling canApproveAllDelegatedWork surfaces it on the Approve menu and
  // maps the shared `a` accelerator to it (the base owns both). A proposal
  // always has a streamId.
  protected override get canApproveAllDelegatedWork(): boolean {
    return true;
  }

  protected override approveAllDelegatedWorkHandler(): void {
    this.emitAction(this.approveAllDelegatedWorkDecision);
  }

  override render(): TemplateResult {
    const data = this.permission.data;
    const modelOptions = this.permission.modelOptions ?? [];
    const agentOptions = this.permission.agentOptions ?? [];
    const isWorkflow = data.agentCategory === AgentCategory.Workflow;
    const workflowScript = isWorkflow ? data.workflowScript : undefined;
    let categoryLabel = 'Tool-Use';
    if (isWorkflow) categoryLabel = 'Workflow';
    if (workflowScript) categoryLabel = 'Multi-agent workflow';
    const currentModel = this.selectedModel ?? data.model;
    const currentAgent = this.selectedAgent ?? data.agent;
    const hasModelOptions = !workflowScript && modelOptions.length > 0;
    const hasAgentOptions = !workflowScript && agentOptions.length > 0;

    return this.renderRequestShell({
      prefix: 'workflow-proposal',
      details: html`
        <div class="workflow-proposal__header-row">
          <wa-badge
            variant=${isWorkflow ? 'neutral' : 'brand'}
            appearance="filled"
          >
            ${categoryLabel}
          </wa-badge>
          ${
            hasAgentOptions
              ? html`
                  <div class="workflow-proposal__agent-select">
                    ${waIcon('wand-magic-sparkles')}
                    <wa-select
                      class="proposal-agent-dropdown"
                      .value=${currentAgent}
                      @change=${this.handleAgentSelectChange}
                    >
                      ${renderAgentOptions(agentOptions)}
                    </wa-select>
                  </div>
                `
              : html`<span class="workflow-proposal__agent"
                  >${data.agent}</span
                >`
          }
          ${
            hasModelOptions
              ? html`
                  <div class="workflow-proposal__model-select">
                    ${waIcon('robot')}
                    <wa-select
                      class="proposal-model-dropdown"
                      .value=${currentModel}
                      @change=${this.handleSelectChange}
                    >
                      ${renderModelOptions(modelOptions)}
                    </wa-select>
                  </div>
                `
              : html`<span class="workflow-proposal__model"
                  >${data.model}</span
                >`
          }
        </div>
        ${
          workflowScript
            ? this.renderWorkflowScriptSummary(data)
            : html`${this.renderInstruction(data.instruction)}
              ${isWorkflow ? this.renderExtractFlags(data) : nothing}
              ${this.renderProposalFiles(data)}`
        }
      `,
      approveTitle: 'Approve (y)',
      rejectTitle: 'Reject (n)',
      trailingActions: renderLabeledActionButton({
        id: 'proposal-setup-button',
        icon: 'reply',
        text: 'Setup',
        tooltip: 'Setup (s)',
        action: 'setup',
        onClick: () => this.emitAction({ action: 'setup' }),
      }),
    });
  }

  // ===========================================================================
  // Proposal-specific rendering
  // ===========================================================================

  private renderWorkflowScriptSummary(
    data: AgentProposalPermission,
  ): TemplateResult | typeof nothing {
    if (data.agentCategory !== AgentCategory.Workflow || !data.workflowScript) {
      return nothing;
    }
    const workflow = data.workflowScript;
    const phaseCount = workflow.phases.length;
    const taskCount = workflow.tasks.length;
    const activeSummary = workflow.phases[0]?.title ?? 'No declared phases';
    const fullName = `${workflow.name}: ${workflow.description}`;

    return html`
      <div class="workflow-proposal__workflow-summary">
        ${waIcon('list-ul', { label: 'Proposed' })}
        <span class="workflow-proposal__workflow-name" title=${fullName}
          >${workflow.name}</span
        >
        <span class="workflow-proposal__workflow-progress"
          >${taskCount} tasks · ${phaseCount} phases</span
        >
        <span class="workflow-proposal__workflow-phase" title=${activeSummary}
          >${activeSummary}</span
        >
      </div>
      <div class="workflow-proposal__cost-warning">
        ${waIcon('triangle-exclamation')} May run tasks concurrently and incur
        high model cost. Default agent: ${data.agent} (${data.model}).
      </div>
      <wa-details
        class="workflow-proposal__workflow-details"
        summary="Workflow details"
      >
        ${this.renderInstruction(workflow.description)}
        ${
          workflow.tasks.length > 0
            ? html`<ul class="workflow-proposal__task-list">
                ${repeat(
                  workflow.tasks,
                  (task) => task.id,
                  (task) =>
                    html`<li>
                      ${task.label}${task.phase ? ` · ${task.phase}` : ''}
                    </li>`,
                )}
              </ul>`
            : nothing
        }
        ${this.renderProposalFiles(data)}
        ${this.renderProposalFileList('Script', [workflow.scriptPath], true)}
      </wa-details>
    `;
  }

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
    return html`<div id="proposal-working-directory">
        <span class="workflow-proposal__file-label">Working directory:</span>
        <span
          class="workflow-proposal__file-name workflow-proposal__file-name--readonly workflow-proposal__file-name--wrap"
          >${workingDirectory}</span
        >
      </div>
      <wa-tooltip for="proposal-working-directory"
        >${workingDirectory}</wa-tooltip
      >`;
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
    if (data.toolConfig.autoExtractFigure) flags.push('Extract figures');
    if (data.toolConfig.autoExtractTikzFigure) flags.push('Extract TikZ');
    if (flags.length === 0) return nothing;
    return html`<div class="workflow-proposal__extract-flags">
      ${repeat(
        flags,
        (flag) => flag,
        (flag) =>
          html`<wa-badge variant="neutral" appearance="filled"
            >${waIcon('image')} ${flag}</wa-badge
          >`,
      )}
    </div>`;
  }

  private renderProposalFileList(
    label: string,
    files: readonly string[],
    clickable: boolean,
  ): TemplateResult | typeof nothing {
    if (files.length === 0) return nothing;

    const idPrefix = `proposal-${label.toLowerCase()}`.replaceAll(
      /[^a-z0-9_-]/g,
      '-',
    );
    return html`
      <div
        class="workflow-proposal__${label.toLowerCase()}-files"
        @click=${this.handleFileClick}
        @keydown=${this.handleFileKey}
      >
        <span class="workflow-proposal__file-label">${label}:</span>
        ${repeat(
          files,
          (file) => file,
          (file, i) =>
            html`${i > 0 ? ', ' : ''}<span
                id="${idPrefix}-file-${i}"
                class="workflow-proposal__file-name${
                  clickable ? '' : ' workflow-proposal__file-name--readonly'
                }"
                data-file=${ifDefined(clickable ? file : undefined)}
                role=${ifDefined(clickable ? 'button' : undefined)}
                tabindex=${ifDefined(clickable ? '0' : undefined)}
                >${getBasename(file)}</span
              ><wa-tooltip for="${idPrefix}-file-${i}">${file}</wa-tooltip>`,
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

  // Keyboard activation parity for the clickable file-name spans (Enter/Space),
  // mirroring FileList.ts's handleFileKey delegate for the same job.
  private handleFileKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const fileEl = getComposedPathElement<HTMLElement>(
      event,
      '.workflow-proposal__file-name[data-file]',
    );
    if (!fileEl) return;
    event.preventDefault();
    const file = fileEl.dataset.file;
    if (file) {
      postMessage(PROGRESS_VIEW_COMMANDS.OPEN_FILE, { file });
    }
  };

  private handleSelectChange = (event: Event): void => {
    const value = readSelectValue(event);
    if (value) {
      this.selectedModel = value;
    }
  };

  private handleAgentSelectChange = (event: Event): void => {
    const value = readSelectValue(event);
    if (value) {
      this.selectedAgent = value;
    }
  };

  private get proposalOverrides(): { model?: string; agent?: string } {
    const { model, agent } = this.permission.data;
    const { selectedModel, selectedAgent } = this;
    return {
      ...(selectedModel && selectedModel !== model
        ? { model: selectedModel }
        : {}),
      ...(selectedAgent && selectedAgent !== agent
        ? { agent: selectedAgent }
        : {}),
    };
  }

  private get approveAllDelegatedWorkDecision() {
    return {
      action: APPROVE_ALL_DELEGATED_WORK_ACTION,
      ...this.proposalOverrides,
    } as const;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'proposal-request-panel': ProposalRequestPanel;
  }
}
