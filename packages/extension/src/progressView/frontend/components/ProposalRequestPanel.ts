/** Agent proposal card: "Delegate a task to reviewer" / "Start a multi-agent run: …". */

// Third-party imports
import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import type {
  AgentProposalPermission,
  PermissionPayload,
  WorkflowAgentProposalPermission,
} from '@shared/schemas';
import { AgentCategory, getProposalFileGroups } from '@shared/schemas';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { workflowRunModel } from '@shared/runs/workflowRunModel';
import { getModelLabel } from '@shared/model/modelLabel';
import { APPROVE_ALL_DELEGATED_WORK_ACTION } from '@shared/session/approvalDecision';
import { selectStyles } from '@ui/styles';
import {
  DELEGATION_APPROVAL_COPY,
  RUN_GRANT_LABEL,
} from '@ui/copy/delegationApproval';

// Local imports - shared utils
import {
  WORKFLOW_SCRIPT_PROPOSAL_COPY,
  workflowScriptPlanSummary,
  workflowScriptStepCount,
} from '@ui/copy/workflowScriptProposal';
import { markdownStyles } from '@ui/styles/markdownStyles';
import {
  readSelectValue,
  renderAgentOptions,
  renderModelOptions,
} from '@ui/wa/selectTemplates';

// Local imports - shared utilities
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { getBasename } from '@utils/core';

// Local imports - base class
import { BaseRequestPanel, type RunGrant } from './BaseRequestPanel';
import { proposalRequestPanelStyles } from './ProposalRequestPanel.styles';
import { buildStatusBadge } from '../formatters/htmlBuilders';
import { processMarkdownContent } from '../formatters/markdownRenderer';
import { getComposedPathElement } from '../utils';

function proposalRequestIdOf(
  p: PermissionPayload | null | undefined,
): string | undefined {
  return p?.kind === 'proposal' ? p.data.requestId : undefined;
}

@customElement('proposal-request-panel')
export class ProposalRequestPanel extends BaseRequestPanel<'proposal'> {
  static override styles = [
    BaseRequestPanel.styles,
    markdownStyles,
    proposalRequestPanelStyles,
    selectStyles,
  ];

  @state() private selectedModel: string | null = null;
  @state() private selectedAgent: string | null = null;

  protected override submitPrimary(): void {
    this.emitAction({ action: 'approve', ...this.proposalOverrides });
  }

  protected override get grant(): RunGrant {
    return {
      label: RUN_GRANT_LABEL.superYolo,
      scope: DELEGATION_APPROVAL_COPY.progressViewToggle,
      decision: {
        action: APPROVE_ALL_DELEGATED_WORK_ACTION,
        ...this.proposalOverrides,
      },
    };
  }

  /**
   * What the agent wants to start, naming the agent (unless the agent
   * picker below names it) and the model (unless the model picker does).
   */
  protected override renderAsk(): TemplateResult {
    const data = this.permission.data;
    if (data.agentCategory === AgentCategory.Workflow && data.workflowScript) {
      return html`Start a multi-agent run:
        <strong>${data.workflowScript.name}</strong> on
        ${getModelLabel(data.model)}`;
    }
    const agent =
      (this.permission.agentOptionsData ?? []).length > 0
        ? nothing
        : html` <strong>${data.agent}</strong>`;
    const model =
      (this.permission.modelOptionsData ?? []).length > 0
        ? nothing
        : html` on ${getModelLabel(data.model)}`;
    return data.agentCategory === AgentCategory.Workflow
      ? html`Run${agent === nothing ? ' an agent' : agent}${model}`
      : html`Delegate a
        task${agent === nothing ? '' : html` to${agent}`}${model}`;
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

  override render(): TemplateResult {
    const data = this.permission.data;
    const modelOptions = this.permission.modelOptionsData ?? [];
    const agentOptions = this.permission.agentOptionsData ?? [];
    const isWorkflow = data.agentCategory === AgentCategory.Workflow;
    const workflowScript = isWorkflow ? data.workflowScript : undefined;

    // The transport ships option data only for proposals whose approval
    // honors a model/agent override; the pickers render iff it arrived.
    const pickers =
      agentOptions.length > 0 || modelOptions.length > 0
        ? html`<div class="workflow-proposal__pickers">
            ${
              agentOptions.length > 0
                ? html`<wa-select
                    class="proposal-agent-dropdown"
                    .value=${this.selectedAgent ?? data.agent}
                    @change=${this.handleAgentSelectChange}
                  >
                    <span slot="label" class="visually-hidden">Agent</span>
                    ${waIcon('wand-magic-sparkles', { slot: 'start' })}
                    ${renderAgentOptions(agentOptions)}
                  </wa-select>`
                : nothing
            }
            ${
              modelOptions.length > 0
                ? html`<wa-select
                    class="proposal-model-dropdown"
                    .value=${this.selectedModel ?? data.model}
                    @change=${this.handleSelectChange}
                  >
                    <span slot="label" class="visually-hidden">Model</span>
                    ${waIcon('robot', { slot: 'start' })}
                    ${renderModelOptions(modelOptions)}
                  </wa-select>`
                : nothing
            }
          </div>`
        : nothing;

    return this.renderCard(
      workflowScript
        ? this.renderWorkflowScriptSummary(data, workflowScript)
        : html`${pickers} ${this.renderInstruction(data.instruction)}
          ${isWorkflow ? this.renderExtractFlags(data) : nothing}
          ${this.renderProposalFiles(data)}`,
      renderLabeledActionButton({
        id: 'proposal-setup-button',
        icon: 'reply',
        text: 'Edit as new task',
        tooltip: 'Edit as new task (s)',
        action: 'setup',
        disabled: this.readOnly,
        onClick: () => this.emitAction({ action: 'setup' }),
      }),
    );
  }

  // ===========================================================================
  // Proposal-specific rendering
  // ===========================================================================

  /**
   * The proposal card (board W0): what the run will be, as the run model
   * folds the plan for a run that has not started. Every declared phase in
   * order with its declared calls (the model is in the ask above), and the
   * honest note that calls may run concurrently. No cost estimate
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
      runPhase: undefined,
      runDurablyFinal: false,
      childProgress: new Map(),
    });

    return html`
      <div class="proposal-card__lede">
        <span>${workflow.description}</span>
        <span class="proposal-card__summary"
          >${workflowScriptPlanSummary(workflow)}</span
        >
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
                    <span class="proposal-card__phase-calls"
                      >${
                        phase.declaredTasks.length > 0
                          ? workflowScriptStepCount(phase.declaredTasks.length)
                          : ''
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
}

declare global {
  interface HTMLElementTagNameMap {
    'proposal-request-panel': ProposalRequestPanel;
  }
}
