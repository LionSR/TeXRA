/** Agent proposal request panel. */

// Third-party imports
import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';

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
  renderAgentOptions,
  renderModelOptions,
} from '@shared/utils/selectTemplates';

// Local imports - shared schemas
import { getProposalFileGroups } from '@shared/schemas/proposalFields';

// Local imports - shared utilities
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderWorkflowExtractFlagBadges } from '@shared/wa/extractFlagBadges';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';
import { getBasename } from '@utils/core';

// Local imports - base class
import { BaseApprovalPanel } from './BaseApprovalPanel';
import { proposalRequestPanelStyles } from './ProposalRequestPanel.styles';
import { APPROVE_ALL_DELEGATED_WORK_ACTION } from '../events';
import { processMarkdownContent } from '../formatters/markdownRenderer';
import { getComposedPathElement } from '../utils';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';
import type { PermissionState } from '../permissionState';

function proposalIdOf(
  p: PermissionState | null | undefined,
): string | undefined {
  return p?.kind === PERMISSION_KIND.PROPOSAL ? p.data.proposalId : undefined;
}

// Read from currentTarget (the wa-select host) instead of target. wa-select can
// retarget events from internal elements, and HTMLSelectElement is the wrong type
// for this Web Component anyway.
function readSelectValue(event: Event): string {
  const select = event.currentTarget as WaSelect | null;
  return typeof select?.value === 'string' ? select.value : '';
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
      case 'a':
        if (this.showFeedback) return false;
        this.emitAction(this.approveAllDelegatedWorkDecision);
        return true;
      case 's':
        this.emitAction({ action: 'setup' });
        return true;
      default:
        return false;
    }
  }

  // Proposals carry a stronger approval action than the edit/bash bypass.
  // Override the base Approve button to surface it and map the shared `a`
  // accelerator to the same action. A proposal always has a streamId.
  protected override renderApproveButton(approveTitle: string): TemplateResult {
    return html`
      <approve-split-button
        .approveTitle=${approveTitle}
        .canBypass=${false}
        .canApproveAllDelegatedWork=${true}
        @approve=${() => this.emitAction(this.approvalDecision)}
        @approve-all-delegated-work=${() =>
          this.emitAction(this.approveAllDelegatedWorkDecision)}
      ></approve-split-button>
    `;
  }

  override render(): TemplateResult {
    const data = this.permission.data;
    const modelOptions = this.permission.modelOptions ?? [];
    const agentOptions = this.permission.agentOptions ?? [];
    const isWorkflow = data.agentCategory === AgentCategory.Workflow;
    const categoryLabel = isWorkflow ? 'Workflow' : 'Tool-Use';
    const currentModel = this.selectedModel ?? data.model;
    const currentAgent = this.selectedAgent ?? data.agent;
    const hasModelOptions = modelOptions.length > 0;
    const hasAgentOptions = agentOptions.length > 0;

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
                    <wa-icon
                      library=${TEXRA_ICON_LIBRARY}
                      name="sparkle"
                      aria-hidden="true"
                    ></wa-icon>
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
                    <wa-icon
                      library=${TEXRA_ICON_LIBRARY}
                      name="robot"
                      aria-hidden="true"
                    ></wa-icon>
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
        ${this.renderInstruction(data.instruction)}
        ${isWorkflow ? this.renderExtractFlags(data) : nothing}
        ${this.renderProposalFiles(data)}
      `,
      approveTitle: 'Approve (y)',
      rejectTitle: 'Reject (n)',
      trailingActions: renderLabeledActionButton({
        icon: 'reply',
        text: 'Setup',
        title: 'Setup (s)',
        action: 'setup',
        onClick: () => this.emitAction({ action: 'setup' }),
      }),
    });
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
    const badges = renderWorkflowExtractFlagBadges(data.toolConfig);
    if (badges === nothing) return nothing;
    return html`<div class="workflow-proposal__extract-flags">${badges}</div>`;
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
        @keydown=${this.handleFileKey}
      >
        <span class="workflow-proposal__file-label">${label}:</span>
        ${repeat(
          files,
          (file) => file,
          (file, i) =>
            html`${i > 0 ? ', ' : ''}<span
                class="workflow-proposal__file-name${
                  clickable ? '' : ' workflow-proposal__file-name--readonly'
                }"
                title=${file}
                data-file=${ifDefined(clickable ? file : undefined)}
                role=${ifDefined(clickable ? 'button' : undefined)}
                tabindex=${ifDefined(clickable ? '0' : undefined)}
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
    const data = this.permission.data;
    const pickIfChanged = (
      selected: string | null,
      original: string,
    ): string | undefined =>
      selected && selected !== original ? selected : undefined;
    const model = pickIfChanged(this.selectedModel, data.model);
    const agent = pickIfChanged(this.selectedAgent, data.agent);
    return {
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
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
