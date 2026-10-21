/** Agent proposal card: "Delegate a task to reviewer" / "Start a team run: …". */

// Third-party imports
import {
  getBasename,
  agentKey,
  agentName,
  getProposalFileGroups,
  type AgentProposalPermission,
  type PermissionPayload,
} from '@texra-ai/harness/schemas';
import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
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
import { modelRefOf } from '@texra-ai/llm';
import { getModelLabel } from '@texra-ai/harness/schemas';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import { APPROVE_ALL_DELEGATED_WORK_ACTION } from '@texra/shared/session/surfaceDecision';
import { SessionUiEvents } from '@texra/shared/session/uiEvents';
import { DocumentTaskOptionsSchema } from '@texra/shared/plugins/documents';
import { selectStyles } from '@ui/styles';
import {
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
import {
  readSelectValue,
  renderAgentOptions,
  renderModelOptions,
} from '@ui/wa/selectTemplates';

// Local imports - shared utilities
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';

// Local imports - base class
import { BaseRequestPanel, type RunGrant } from './BaseRequestPanel';
import { proposalRequestPanelStyles } from './ProposalRequestPanel.styles';
import { buildStatusBadge } from '../formatters/htmlBuilders';
import { processMarkdownContent } from '../formatters/markdownRenderer';
import { getComposedPathElement } from '../utils';
import type { RunView } from '@texra-ai/harness/schemas';

/** The proposal's agent as an option value: options carry source-qualified
 *  keys, and a proposal with no source names the agent bare. */
function proposedAgentKey({ agent, agentSource }: AgentProposalPermission) {
  return agentSource == null ? agent : agentKey(agentSource, agent);
}

/** Whether an agent option value (a key) is the proposal's agent: the
 *  exact key, or, for a proposal with no source, any key of that name.
 *  Every agent match on the card goes through this. */
function isProposedAgent(
  value: string,
  data: AgentProposalPermission,
): boolean {
  return (
    value === proposedAgentKey(data) ||
    (data.agentSource == null && agentName(value) === data.agent)
  );
}

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

  /** The host's catalogs, the lists the composer launches from. */
  @property({ attribute: false }) host: HostSnapshot | null = null;

  /** The asking run: its `agentScope` bounds the agent picker. */
  @property({ attribute: false }) run: RunView | null = null;

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
    if (data.script) {
      return html`${SCRIPT_REQUEST_COPY.title(data.script)}`;
    }
    const { agents, models } = this.pickers;
    const agent =
      agents.length > 0 ? nothing : html` <strong>${data.agent}</strong>`;
    const model =
      models.length > 0 ? nothing : html` on ${getModelLabel(data.model)}`;
    return data.task
      ? html`Run${agent === nothing ? ' an agent' : agent}${model}`
      : html`Delegate a
        task${agent === nothing ? '' : html` to${agent}`}${model}`;
  }

  // Reset selections only when the proposal's identity changes, so an async
  // permission upsert that just adds dropdown options doesn't wipe the user's
  // in-progress pick for the same proposal.
  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    const previous = changed.get('permission') as
      PermissionPayload | null | undefined;
    if (
      changed.has('permission') &&
      proposalRequestIdOf(previous) !== proposalRequestIdOf(this.permission)
    ) {
      this.selectedModel = null;
      this.selectedAgent = null;
    }
    // A catalog refresh may drop a pick: the select then shows the
    // proposal again, which the pickers always offer.
    const { agents, models } = this.pickers;
    if (!agents.some(({ value }) => value === this.selectedAgent))
      this.selectedAgent = null;
    if (!models.some(({ value }) => value === this.selectedModel))
      this.selectedModel = null;
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
    const { agents: agentOptions, models: modelOptions } = this.pickers;
    const pickers =
      agentOptions.length > 0 || modelOptions.length > 0
        ? html`<div class="workflow-proposal__pickers">
            ${
              agentOptions.length > 0
                ? html`<wa-select
                    class="proposal-agent-dropdown"
                    .value=${this.selectedAgent ?? this.proposedAgent}
                    ?disabled=${this.readOnly}
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
                    .value=${this.selectedModel ?? this.proposedModel}
                    ?disabled=${this.readOnly}
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

    let body: TemplateResult;
    if (data.script)
      body = html`${pickers} ${this.renderScriptSummary(data, data.script)}`;
    else
      body = html`${pickers} ${this.renderInstruction(data.instruction)}
      ${data.task ? this.renderExtractFlags(data) : nothing}
      ${this.renderProposalFiles(data)}`;
    return this.renderCard(
      body,
      renderLabeledActionButton({
        id: 'proposal-setup-button',
        icon: 'reply',
        text: 'Change and start myself',
        tooltip: 'Change and start myself (s)',
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

  /**
   * What the pickers offer, from the host's catalogs: the agents the run
   * may delegate to (its team's, which may be hidden from the catalog,
   * else every visible one), and for a task only the catalog's agents
   * with a document task, and the proposed one. A script's request
   * approves the script, not one call's agent or model (`decideDelegation`
   * ignores both there), so it offers none. A proposed agent or model
   * the catalog no longer lists stays offered as proposed, so the select
   * always shows what an unchanged approval launches.
   */
  private get pickers(): {
    agents: HostSnapshot['agentOptions'];
    models: HostSnapshot['modelOptions'];
  } {
    const { host } = this;
    const data = this.permission.data;
    const { script, task, agent, model } = data;
    if (host === null || script) return { agents: [], models: [] };
    const scope = this.run?.agentScope ?? null;
    const offered = (option: HostSnapshot['agentOptions'][number]) =>
      !task || option.rounds !== undefined;
    const agents =
      scope === null
        ? host.agentOptions.filter(offered)
        : scope.flatMap((key) => {
            const option = host.agentOptions.find(({ value }) => value === key);
            // A member the catalog hides is offered as the team names it,
            // but for a task only when proposed: whether it has a task is
            // not in the catalog.
            if (option === undefined)
              return !task || isProposedAgent(key, data)
                ? [{ value: key, label: agentName(key) }]
                : [];
            return offered(option) ? [option] : [];
          });
    const ref = modelRefOf(model) ?? model;
    const models = host.modelOptions;
    return {
      agents:
        agents.length === 0 ||
        agents.some((o) => isProposedAgent(o.value, data))
          ? agents
          : [{ value: proposedAgentKey(data), label: agent }, ...agents],
      models:
        models.length === 0 ||
        models.some((o) => [ref, model].includes(o.value))
          ? models
          : [{ value: model, label: getModelLabel(model) }, ...models],
    };
  }

  /** The proposed agent's option value (`isProposedAgent`). */
  private get proposedAgent(): string {
    const data = this.permission.data;
    return (
      this.pickers.agents.find((o) => isProposedAgent(o.value, data))?.value ??
      data.agent
    );
  }

  /** The proposed model's option value: options name a model without
   *  its effort or mode, which the proposal may carry (`ref@high`). An
   *  unchanged pick sends no override, so the proposal's own form runs. */
  private get proposedModel(): string {
    const { model } = this.permission.data;
    const ref = modelRefOf(model) ?? model;
    return this.pickers.models.some((option) => option.value === ref)
      ? ref
      : model;
  }

  private get proposalOverrides(): { model?: string; agent?: string } {
    const model = this.proposedModel;
    const agent = this.proposedAgent;
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
