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
import {
  commonViewStyles,
  designTokens,
  requestPanelSharedStyles,
  selectStyles,
} from '@shared/styles';

// Local imports - shared utils
import type {
  AgentProposalPermission,
  PermissionPayload,
  WorkflowAgentProposalPermission,
} from '@shared/schemas';
import { AgentCategory, getProposalFileGroups } from '@shared/schemas';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { workflowRunModel } from '@shared/streams/workflowRunModel';
import {
  WORKFLOW_SCRIPT_PROPOSAL_COPY,
  workflowScriptPlanSummary,
} from '@shared/copy/workflowScriptProposal';
import { markdownStyles } from '@shared/styles/markdownStyles';
import { getModelLabel } from '@shared/model/modelLabel';
import {
  readSelectValue,
  renderAgentOptions,
  renderModelOptions,
} from '@shared/wa/selectTemplates';

// Local imports - shared utilities
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { getBasename } from '@utils/core';

// Local imports - base class
import { BaseApprovalPanel } from './BaseApprovalPanel';
import { proposalRequestPanelStyles } from './ProposalRequestPanel.styles';
import { APPROVE_ALL_DELEGATED_WORK_ACTION } from '../events';
import { buildStatusBadge } from '../formatters/htmlBuilders';
import { processMarkdownContent } from '../formatters/markdownRenderer';
import { getComposedPathElement } from '../utils';

function proposalRequestIdOf(
  p: PermissionPayload | null | undefined,
): string | undefined {
  return p?.kind === PERMISSION_KIND.PROPOSAL ? p.data.requestId : undefined;
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
      PermissionPayload | null | undefined;
    if (
      proposalRequestIdOf(previous) !== proposalRequestIdOf(this.permission)
    ) {
      this.selectedModel = null;
      this.selectedAgent = null;
    }
  }

  protected override handleExtraKey(key: string): boolean {
    if (key === 's') {
      this.emitAction({ action: 'setup' });
      return true;
    }
    return false;
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
    const modelOptions = this.permission.modelOptionsData ?? [];
    const agentOptions = this.permission.agentOptionsData ?? [];
    const isWorkflow = data.agentCategory === AgentCategory.Workflow;
    const workflowScript = isWorkflow ? data.workflowScript : undefined;
    let categoryLabel = 'Tool-Use';
    if (workflowScript) {
      categoryLabel = 'Multi-agent workflow';
    } else if (isWorkflow) {
      categoryLabel = 'Workflow';
    }
    const currentModel = this.selectedModel ?? data.model;
    const currentAgent = this.selectedAgent ?? data.agent;
    // The transport ships option data only for proposals whose approval
    // honors a model/agent override; the dropdowns render iff it arrived.
    const hasModelOptions = modelOptions.length > 0;
    const hasAgentOptions = agentOptions.length > 0;

    // The workflow-script card (W0) opens on its own head, 'Proposes a
    // multi-agent run'; the kind, agent, and model row belongs to the other
    // proposals, whose head is that row.
    const headerRow = workflowScript
      ? nothing
      : html`<div class="workflow-proposal__header-row">
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
                      <span slot="label" class="visually-hidden"
                        >Agent for this proposal</span
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
                      <span slot="label" class="visually-hidden"
                        >Model for this proposal</span
                      >
                      ${renderModelOptions(modelOptions)}
                    </wa-select>
                  </div>
                `
              : html`<span class="workflow-proposal__model"
                  >${getModelLabel(data.model)}</span
                >`
          }
        </div>`;
    return this.renderRequestShell({
      prefix: 'workflow-proposal',
      details: html`
        ${headerRow}
        ${
          workflowScript
            ? this.renderWorkflowScriptSummary(data, workflowScript)
            : html`${this.renderInstruction(data.instruction)}
              ${isWorkflow ? this.renderExtractFlags(data) : nothing}
              ${this.renderProposalFiles(data)}`
        }
      `,
      approveTitle: workflowScript
        ? 'Approve and run this workflow (y)'
        : 'Approve this proposal (y)',
      approveLabel: workflowScript ? 'Approve and run' : 'Approve',
      rejectTitle: 'Reject this proposal (n)',
      trailingActions: html`${renderLabeledActionButton({
        id: 'proposal-setup-button',
        icon: 'reply',
        text: 'Edit as new task',
        tooltip: 'Edit as new task (s)',
        action: 'setup',
        onClick: () => this.emitAction({ action: 'setup' }),
      })}${
        workflowScript
          ? html`<wa-button
              id="proposal-skip-button"
              class="proposal-card__skip"
              appearance="plain"
              variant="neutral"
              size="s"
              type="button"
              ?disabled=${this.readOnly}
              @click=${() => this.approveAllDelegatedWorkHandler()}
              >Skip proposals this session</wa-button
            >`
          : nothing
      }`,
    });
  }

  // ===========================================================================
  // Proposal-specific rendering
  // ===========================================================================

  /**
   * The proposal card (board W0): what the run will be, as the run model
   * folds the plan for a run that has not started. Every declared phase in
   * order with its declared calls, the proposal's default agent and model,
   * and the honest note that calls may run concurrently. No cost estimate
   * (the fold has none) and no script link (the file list below has it).
   */
  private renderWorkflowScriptSummary(
    data: AgentProposalPermission,
    workflow: NonNullable<WorkflowAgentProposalPermission['workflowScript']>,
  ): TemplateResult {
    const { phases } = workflowRunModel({
      taskGroups: [],
      rows: [],
      plan: workflow,
      streamPhase: undefined,
      runDurablyFinal: false,
      childProgress: new Map(),
    });
    const modelLabel = getModelLabel(data.model);

    return html`
      <div class="proposal-card__head">
        ${waIcon('diagram-project')}
        <strong>Proposes a multi-agent run</strong>
        <span class="proposal-card__summary"
          >${workflowScriptPlanSummary(workflow)}</span
        >
      </div>
      <div class="proposal-card__lede">
        <span class="workflow-proposal__workflow-name" title=${workflow.name}
          >${workflow.name}</span
        >
        <span aria-hidden="true">·</span>
        <span>${workflow.description}</span>
      </div>
      ${
        phases.length > 0
          ? html`<div class="proposal-card__phases" role="list">
              ${repeat(
                phases,
                (phase) => phase.key,
                (phase) => html`
                  <div class="proposal-card__phase" role="listitem">
                    ${waIcon('diagram-project')}
                    <strong>${phase.heading.phaseLabel}</strong>
                    <span class="proposal-card__phase-agents"
                      >${data.agent} · ${modelLabel}</span
                    >
                    <span class="proposal-card__phase-calls"
                      >${
                        phase.declaredTasks.length > 0
                          ? `${phase.declaredTasks.length} ${
                              phase.declaredTasks.length === 1
                                ? 'call'
                                : 'calls'
                            }`
                          : 'calls at runtime'
                      }</span
                    >
                  </div>
                `,
              )}
            </div>`
          : nothing
      }
      <div class="workflow-proposal__cost-warning">
        ${waIcon('triangle-exclamation')}
        ${WORKFLOW_SCRIPT_PROPOSAL_COPY.costWarning}
        ${
          workflow.tasks.length > 0
            ? WORKFLOW_SCRIPT_PROPOSAL_COPY.declaredItemsNote
            : WORKFLOW_SCRIPT_PROPOSAL_COPY.dynamicCallsNote
        }
      </div>
      <wa-details
        class="workflow-proposal__workflow-details"
        summary="Instruction and files"
      >
        ${this.renderInstruction(data.instruction)}
        ${
          getProposalFileGroups(data).length > 0
            ? html`<div class="workflow-proposal__plan-note">
                ${WORKFLOW_SCRIPT_PROPOSAL_COPY.filesHeading}:
              </div>`
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
        (flag) => buildStatusBadge('image', flag),
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
                aria-label=${ifDefined(clickable ? `Open ${file}` : undefined)}
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
    if (file) this.openFile(file);
  };

  private openFile(path: string): void {
    this.dispatchEvent(
      SessionUiEvents.host({ kind: 'openFile', path, line: null }),
    );
  }

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
    if (file) this.openFile(file);
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
