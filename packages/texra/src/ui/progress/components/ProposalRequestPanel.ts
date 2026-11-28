/** Agent proposal card: "Delegate a task to reviewer". */

// Third-party imports
import {
  getBasename,
  getProposalFileGroups,
  type AgentProposalRequest,
} from '@texra-ai/worldline/schemas';
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { CHILD_AGENT_COPY } from '@ui/copy/delegationApproval';
import { modelSelectionLabel } from '@texra/shared/model/modelPicker';
import { REQUEST_ASK, WORKING_DIRECTORY_LABEL } from '@ui/copy/requestCards';

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
import { BaseRequestPanel } from './BaseRequestPanel';
import { proposalRequestPanelStyles } from './ProposalRequestPanel.styles';
import {
  buildFileLinkSpan,
  buildStatusBadge,
  FILE_LINK,
  fileLinkTarget,
} from '../formatters/htmlBuilders';
import { renderMarkdownHtml } from '../formatters/markdownRenderer';
import { proposalLaunchPatch } from '../proposalEdit';
import { delegateKeyActivation } from './composedPath';

@customElement('proposal-request-panel')
export class ProposalRequestPanel extends BaseRequestPanel<'proposal'> {
  static override styles = [
    BaseRequestPanel.styles,
    markdownStyles,
    proposalRequestPanelStyles,
  ];

  /** The host's catalogs, the lists the launch form offers. */
  @property({ attribute: false }) host: HostSnapshot | null = null;

  /** What the agent wants to start: the agent and the model. */
  protected override renderAsk(): TemplateResult {
    const data = this.permission.data;
    if (data.script) {
      return html`${SCRIPT_REQUEST_COPY.title(data.script)}`;
    }
    const agent = html` <strong>${data.label}</strong>`;
    // The model is the agent's own choice; Edit opens the launch form for
    // a person who wants another.
    const model = ` on ${modelSelectionLabel(data.model)}`;
    return html`${REQUEST_ASK.proposal(data.task)}${agent}${model}`;
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
    return this.host !== null && !this.permission.data.script;
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
        patch: proposalLaunchPatch(data),
      }),
    );
  }

  override render(): TemplateResult {
    const data = this.permission.data;
    const body = data.script
      ? this.renderScriptSummary(data, data.script)
      : html`${this.renderDefinedAgent(data)}
        ${this.renderInstruction(data.instruction)}
        ${data.task ? this.renderOptionBadges(data) : nothing}
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
   * A script's request for its `agent` calls: what approving allows,
   * the first agent it asks for, and, collapsed, its code and the calls it
   * issued before it asked.
   */
  private renderScriptSummary(
    data: AgentProposalRequest,
    script: NonNullable<AgentProposalRequest['script']>,
  ): TemplateResult {
    return html`
      <div class="proposal-card__lede">
        <span>${SCRIPT_REQUEST_COPY.grant}</span>
      </div>
      ${this.renderDefinedAgent(data)}
      <div class="workflow-proposal__plan-note">
        ${scriptRequestFirstAgentLine(
          data.label,
          modelSelectionLabel(data.model),
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
                  ${script.calls.map(
                    (call) => html`<li>${scriptRequestCallLine(call)}</li>`,
                  )}
                </ol>`
            : nothing
        }
      </wa-details>
    `;
  }

  /** A chat child: its name and tools, the first sentence of its system
   *  text, and, opened, the whole text. A program's child has none. */
  private renderDefinedAgent(
    data: AgentProposalRequest,
  ): TemplateResult | typeof nothing {
    if (data.system === '') return nothing;
    return html`<div class="workflow-proposal__plan-note">
        ${CHILD_AGENT_COPY.heading(data.label, data.tools)}
      </div>
      <div class="workflow-proposal__plan-note">
        ${CHILD_AGENT_COPY.summary(data.system)}
      </div>
      <wa-details
        class="workflow-proposal__workflow-details"
        summary=${CHILD_AGENT_COPY.promptLabel}
      >
        <div class="workflow-proposal__instruction script-proposal__source">
          <pre><code>${data.system}</code></pre>
        </div>
      </wa-details>`;
  }

  private renderInstruction(instruction: string): TemplateResult {
    const markdownHtml = renderMarkdownHtml(instruction);
    return html`<div class="workflow-proposal__instruction markdown-content">
      ${unsafeHTML(markdownHtml)}
    </div>`;
  }

  private renderWorkingDirectory(
    data: AgentProposalRequest,
  ): TemplateResult | typeof nothing {
    const workingDirectory = data.workingDirectory;
    if (!workingDirectory) return nothing;
    // The path is shown in full and wraps, so it needs no hover hint.
    return html`<div>
      <span class="workflow-proposal__file-label"
        >${WORKING_DIRECTORY_LABEL}:</span
      >
      <span
        class="workflow-proposal__file-name workflow-proposal__file-name--readonly workflow-proposal__file-name--wrap"
        >${workingDirectory}</span
      >
    </div>`;
  }

  private renderProposalFiles(
    data: AgentProposalRequest,
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

  private renderOptionBadges(
    data: AgentProposalRequest,
  ): TemplateResult | typeof nothing {
    // A program's arguments that are switched on, by name.
    const flags = Object.entries(data.options ?? {}).flatMap(([key, value]) =>
      value === true ? [key] : [],
    );
    if (flags.length === 0) return nothing;
    return html`<div class="workflow-proposal__option-badges">
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
            html`${i > 0 ? ', ' : ''}${
              clickable
                ? buildFileLinkSpan(file, getBasename(file), {
                    className: 'workflow-proposal__file-name',
                  })
                : html`<span
                    class="workflow-proposal__file-name workflow-proposal__file-name--readonly"
                    title=${file}
                    >${getBasename(file)}</span
                  >`
            }`,
        )}
      </div>
    `;
  }

  // ===========================================================================
  // Proposal-specific handlers
  // ===========================================================================

  private handleFileClick = (event: MouseEvent | KeyboardEvent): void => {
    const file = fileLinkTarget(event);
    if (file) {
      this.dispatchEvent(
        SessionUiEvents.host({ kind: 'openFile', path: file.path }),
      );
    }
  };

  // Keyboard activation parity for the clickable file names (Enter/Space).
  private handleFileKey = (event: KeyboardEvent): void => {
    delegateKeyActivation(event, FILE_LINK, () => this.handleFileClick(event));
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'proposal-request-panel': ProposalRequestPanel;
  }
}
