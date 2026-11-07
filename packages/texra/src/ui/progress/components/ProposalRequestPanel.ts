/** Agent proposal card: "Delegate a task to reviewer" / "Start a team run: …". */

// Third-party imports
import {
  getBasename,
  getProposalFileGroups,
  type AgentProposalRequest,
  getModelLabel,
} from '@texra-ai/harness/schemas';
import { Record as Rec, Result, Schema } from 'effect';
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import { APPROVE_SESSION_ACTION } from '@texra/shared/session/surfaceDecision';
import { SessionUiEvents } from '@texra/shared/session/uiEvents';
import {
  DOCUMENT_TASK_OPTIONS,
  DocumentTaskOptionsSchema,
} from '@texra/shared/plugins/documents';
import {
  DEFINED_AGENT_COPY,
  DELEGATION_APPROVAL_COPY,
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
import { selectedItemValue } from '@ui/wa/selectTemplates';

// Local imports - base class
import { BaseRequestPanel, type RunGrant } from './BaseRequestPanel';
import { modelMenu } from './composerChipMenus';
import { proposalRequestPanelStyles } from './ProposalRequestPanel.styles';
import { buildStatusBadge } from '../formatters/htmlBuilders';
import { processMarkdownContent } from '../formatters/markdownRenderer';
import { proposalLaunchPatch } from '../proposalEdit';
import { getComposedPathElement } from '../utils';
import type { RunView } from '@texra-ai/harness/schemas';
import type { WaSelectEvent } from '@awesome.me/webawesome/dist/events/events.js';

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

  /** The model picked on the card, for the request it was picked on. */
  @state() private picked: { requestId: string; model: string } | null = null;

  /** The model the run starts on: the one picked here, else the proposal's. */
  private get model(): string {
    const data = this.permission.data;
    return this.picked?.requestId === data.requestId
      ? this.picked.model
      : data.model;
  }

  /** An approval's `model`: stated only when it is not the proposal's. */
  private get modelChange(): { readonly model?: string } {
    return this.model === this.permission.data.model
      ? {}
      : { model: this.model };
  }

  protected override submitPrimary(): void {
    this.emitAction({ action: 'approve', ...this.modelChange });
  }

  // The grant carries the launch form's model change, and its scope names
  // the edits and commands the delegated-work grant also turns on.
  protected override get grant(): RunGrant | null {
    const offered = super.grant;
    return (
      offered && {
        ...offered,
        scope: DELEGATION_APPROVAL_COPY.progressViewToggle,
        decision: { action: APPROVE_SESSION_ACTION, ...this.modelChange },
      }
    );
  }

  /** What the agent wants to start: the agent and the model. */
  protected override renderAsk(): TemplateResult {
    const data = this.permission.data;
    if (data.script) {
      return html`${SCRIPT_REQUEST_COPY.title(data.script)}`;
    }
    const agent = html` <strong>${data.agent}</strong>`;
    const model = html` on ${this.renderModel()}`;
    return data.task
      ? html`Run${agent}${model}`
      : html`Delegate a task to${agent}${model}`;
  }

  /** The model in the ask. On a card that can be answered it is a menu over
   *  the host's models: changing only the model takes one pick here, where
   *  Edit opens the whole launch form. */
  private renderModel(): TemplateResult | string {
    const { host } = this;
    if (!this.editable || host === null) return getModelLabel(this.model);
    const menu = modelMenu(this.model, host);
    return html`<wa-dropdown
      class="proposal-model"
      @wa-select=${(event: WaSelectEvent) => {
        const value = selectedItemValue(event);
        if (!value.startsWith('model:')) return;
        this.picked = {
          requestId: this.permission.data.requestId,
          model: value.slice(6),
        };
      }}
    >
      <wa-button
        slot="trigger"
        id="proposal-model-trigger"
        class="proposal-model__trigger btn-ghost is-compact"
        appearance="plain"
        variant="neutral"
        size="s"
        type="button"
        with-caret
        >${menu.label}</wa-button
      >
      ${menu.items}
    </wa-dropdown>`;
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
        patch: {
          ...proposalLaunchPatch(data, this.run ?? undefined, host),
          model: this.model,
        },
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
    data: AgentProposalRequest,
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
    data: AgentProposalRequest,
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
    // Options the documents plugin cannot read show no flags.
    const options = Result.getOrUndefined(
      Schema.decodeUnknownResult(DocumentTaskOptionsSchema)(data.options ?? {}),
    );
    const flags = Rec.toEntries(DOCUMENT_TASK_OPTIONS)
      .filter(([key]) => options?.[key] === true)
      .map(([, row]) => row.label);
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
    if (!(event.target instanceof HTMLElement)) return;
    const { file } = event.target.dataset;
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
    const fileEl = getComposedPathElement(
      event,
      '.workflow-proposal__file-name[data-file]',
      HTMLElement,
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
