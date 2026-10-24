/** Agent proposal card: "Delegate a task to reviewer" / "Start a team run: …". */

// Third-party imports
import {
  getBasename,
  getProposalFileGroups,
  type AgentProposalPermission,
  getModelLabel,
} from '@texra-ai/harness/schemas';
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import { APPROVE_ALL_DELEGATED_WORK_ACTION } from '@texra/shared/session/surfaceDecision';
import { SessionUiEvents } from '@texra/shared/session/uiEvents';
import { DocumentTaskOptionsSchema } from '@texra/shared/plugins/documents';
import {
  DEFINED_AGENT_COPY,
  DELEGATION_APPROVAL_COPY,
  RUN_GRANT_LABEL,
} from '@ui/copy/delegationApproval';

// Local imports - shared utils
import {
  SCRIPT_REQUEST_COPY,
  scriptRequestCallLine,
  scriptRequestFirstAgentLine,
} from '@ui/copy/scriptRequest';
import { markdownStyles } from '@ui/styles/markdownStyles';

// Local imports - shared utilities
import { renderLabeledActionButton } from '@ui/wa/actionButtons';

// Local imports - base class
import { BaseRequestPanel, type RunGrant } from './BaseRequestPanel';
import { proposalRequestPanelStyles } from './ProposalRequestPanel.styles';
import { buildStatusBadge } from '../formatters/htmlBuilders';
import { processMarkdownContent } from '../formatters/markdownRenderer';
import { proposalLaunchPatch } from '../proposalEdit';
import { getComposedPathElement } from '../utils';
import type { RunView } from '@texra-ai/harness/schemas';

@customElement('proposal-request-panel')
export class ProposalRequestPanel extends BaseRequestPanel<'proposal'> {
  static override styles = [
    BaseRequestPanel.styles,
    markdownStyles,
    proposalRequestPanelStyles,
  ];

  /** The host's catalogs, the lists the launch form offers. */
  @property({ attribute: false }) host: HostSnapshot | null = null;

  /** The asking run: its `agentScope` bounds the form's agents. */
  @property({ attribute: false }) run: RunView | null = null;

  protected override submitPrimary(): void {
    this.emitAction({ action: 'approve' });
  }

  protected override get grant(): RunGrant {
    return {
      label: RUN_GRANT_LABEL.superYolo,
      scope: DELEGATION_APPROVAL_COPY.progressViewToggle,
      decision: { action: APPROVE_ALL_DELEGATED_WORK_ACTION },
    };
  }

  /** What the agent wants to start: the agent and the model. */
  protected override renderAsk(): TemplateResult {
    const data = this.permission.data;
    if (data.script) {
      return html`${SCRIPT_REQUEST_COPY.title(data.script)}`;
    }
    const agent = html` <strong>${data.agent}</strong>`;
    const model = html` on ${getModelLabel(data.model)}`;
    return data.task
      ? html`Run${agent}${model}`
      : html`Delegate a task to${agent}${model}`;
  }

  protected override handleExtraKey(key: string): boolean {
    if (key === 'e' && this.editable) {
      this.edit();
      return true;
    }
    return false;
  }

  /** A script's request approves the script, not one call's agent work,
   *  so only an agent's own proposal opens in the form. */
  private get editable(): boolean {
    return !this.readOnly && this.host !== null && !this.permission.data.script;
  }

  /** Edit: the launch form opens on this proposal, filled with what it
   *  would launch; the form's Send approves it with the changes. */
  private edit(): void {
    const { host } = this;
    if (host === null) return;
    const data = this.permission.data;
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'editProposal',
        proposal: { runId: data.runId, requestId: data.requestId },
        patch: proposalLaunchPatch(data, this.run ?? undefined, host),
      }),
    );
  }

  override render(): TemplateResult {
    const data = this.permission.data;
    const body = data.script
      ? this.renderScriptSummary(data, data.script)
      : html`${this.renderDefinedAgent(data)}
        ${this.renderInstruction(data.instruction)}
        ${data.task ? this.renderExtractFlags(data) : nothing}
        ${this.renderProposalFiles(data)}`;
    return this.renderCard(
      body,
      data.script
        ? nothing
        : renderLabeledActionButton({
            id: 'proposal-edit-button',
            icon: 'pencil',
            text: 'Edit',
            tooltip: 'Edit before approving (e)',
            action: 'edit',
            disabled: !this.editable,
            onClick: () => this.edit(),
          }),
    );
  }

  // ===========================================================================
  // Proposal-specific rendering
  // ===========================================================================

  /**
   * A script's request for its `agent` calls (Q5): what approving allows,
   * the first agent it asks for, and, folded, its code and the calls it
   * issued before it asked.
   */
  private renderScriptSummary(
    data: AgentProposalPermission,
    script: NonNullable<AgentProposalPermission['script']>,
  ): TemplateResult {
    return html`
      <div class="proposal-card__lede">
        <span>${SCRIPT_REQUEST_COPY.grant}</span>
      </div>
      ${this.renderDefinedAgent(data)}
      <div class="workflow-proposal__plan-note">
        ${scriptRequestFirstAgentLine(
          data.agent,
          getModelLabel(data.model),
          data.instruction,
        )}
      </div>
      <wa-details
        class="workflow-proposal__workflow-details"
        summary=${SCRIPT_REQUEST_COPY.showCode(script)}
      >
        <div class="workflow-proposal__instruction script-proposal__source">
          <pre><code>${script.source}</code></pre>
        </div>
        ${
          script.calls.length > 0
            ? html`<div class="workflow-proposal__plan-note">
                  ${SCRIPT_REQUEST_COPY.callsHeading}:
                </div>
                <ol class="script-proposal__calls">
                  ${repeat(
                    script.calls,
                    (_call, index) => index,
                    (call) => html`<li>${scriptRequestCallLine(call)}</li>`,
                  )}
                </ol>`
            : nothing
        }
      </wa-details>
    `;
  }

  /** An agent the call defines, while it stays the pick: its name and
   *  tools, and, open, its prompt. */
  private renderDefinedAgent(
    data: AgentProposalPermission,
  ): TemplateResult | typeof nothing {
    const { persona } = data;
    if (!persona) return nothing;
    return html`<div class="workflow-proposal__plan-note">
        ${DEFINED_AGENT_COPY.heading(persona)}
      </div>
      <wa-details
        class="workflow-proposal__workflow-details"
        summary=${DEFINED_AGENT_COPY.promptLabel}
        open
      >
        <div class="workflow-proposal__instruction script-proposal__source">
          <pre><code>${persona.prompt ?? ''}</code></pre>
        </div>
      </wa-details>`;
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
    // Only a document task revises files; a chat delegation names none.
    const groups = data.task ? getProposalFileGroups(data) : [];
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
    data: AgentProposalPermission,
  ): TemplateResult | typeof nothing {
    // Options the documents plugin cannot read show no flags.
    const options = DocumentTaskOptionsSchema.safeParse(
      data.options ?? {},
    ).data;
    const flags: string[] = [];
    if (options?.autoExtractFigure) flags.push('Extract figures');
    if (options?.autoExtractTikzFigure) flags.push('Extract TikZ');
    if (options?.reflect) flags.push('Critic review');
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
}

declare global {
  interface HTMLElementTagNameMap {
    'proposal-request-panel': ProposalRequestPanel;
  }
}
