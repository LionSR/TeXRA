/**
 * InstructionPanel component for MainView instruction input.
 *
 * Renders the instruction textarea with session type toggle,
 * action buttons, agent/model selectors, and execute button.
 */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, property, query } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { keyed } from 'lit/directives/keyed.js';

// Local imports - shared schemas and types
import type { LaunchTarget } from '@shared/schemas';

// Local imports - shared styles
import { commonViewStyles, designTokens, selectStyles } from '@shared/styles';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - shared utils
import {
  BROWSE_ALL_AGENTS_OPTION_VALUE,
  MANAGE_TEAMS_OPTION_VALUE,
  readSelectValue,
  renderAgentOptions,
  renderModelOptions,
  renderTeamOptions,
} from '@shared/utils/selectTemplates';
import { getTextareaValue } from '@shared/utils/textarea';
import { renderIconActionButton } from '@shared/wa/actionButtons';

// Local imports - main view
import { MainViewEvents } from '../events';
import { FileDropController, postDroppedFiles } from '../fileDropHandler';
import { handleImagePaste } from '../pasteHandler';
import { SESSION_TYPES, type SessionType } from '../constants';
import { sessionContext, type SessionContextValue } from '../mainViewContexts';
import { instructionPanelStyles } from './InstructionPanel.styles';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';
import '@awesome.me/webawesome/dist/components/radio/radio.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';

type SessionHintKey = SessionType | 'orchestrator' | 'team';
type DesktopLaunchMode = 'interactive' | 'team' | 'workflow';

const SESSION_HINT_COPY: Record<
  SessionHintKey,
  { lede: string; body: string; time: string; ariaLabel: string }
> = {
  workflow: {
    lede: 'Deep pass.',
    body: 'Drafts, reviews its own work, then revises — across your whole document.',
    time: 'Typically 5–10 min on fast models, 10–30 min on frontier reasoning. Pick a smaller model if you need faster turnaround.',
    ariaLabel: 'About workflow mode',
  },
  toolUse: {
    lede: 'Conversational.',
    body: 'Reads, edits, and searches in a running dialogue you steer turn by turn.',
    time: 'Turns stream back in seconds; tool-heavy runs take a minute or two. Pick a stronger model for longer chains of reasoning.',
    ariaLabel: 'About interactive mode',
  },
  orchestrator: {
    lede: 'Orchestrator.',
    body: 'Plans a pipeline of specialized agents and dispatches them for you. Name agents to steer delegation, or ask it which one to use.',
    time: 'E.g., “use polish on the intro, then review the math” — or leave it blank. Approve tasks in the Sessions tab as they arrive.',
    ariaLabel: 'About orchestrator mode',
  },
  team: {
    lede: 'Team run.',
    body: 'Starts the team lead in an interactive session with delegation limited to this team.',
    time: '',
    ariaLabel: 'About team runs',
  },
};

function getSessionTitle(type: SessionType): string {
  const copy = SESSION_HINT_COPY[type];
  return `${copy.lede} ${copy.body}`;
}

function isTeamLaunch(
  session: SessionContextValue | null | undefined,
): boolean {
  return (
    session?.sessionType === SESSION_TYPES.TOOL_USE &&
    session.launchTarget === 'team'
  );
}

function selectedAgentId(session: SessionContextValue): string {
  return session.agent[session.sessionType];
}

function getDesktopLaunchMode(session: SessionContextValue): DesktopLaunchMode {
  if (session.sessionType === SESSION_TYPES.WORKFLOW) return 'workflow';
  return session.launchTarget === 'team' ? 'team' : 'interactive';
}

function resolveSessionHintKey(session: SessionContextValue): SessionHintKey {
  // The team hint describes the launcher, so it takes precedence over the
  // orchestrator hint (which describes the selected agent). Workflows always
  // use a single agent, even if stale restored state still says "team".
  if (isTeamLaunch(session)) return 'team';
  if (
    session.sessionType === SESSION_TYPES.TOOL_USE &&
    session.isOrchestratorSelected
  ) {
    return 'orchestrator';
  }
  return session.sessionType;
}

@customElement('instruction-panel')
export class InstructionPanel extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    selectStyles,
    instructionPanelStyles,
  ];

  @consume({ context: sessionContext, subscribe: true })
  private sessionData?: SessionContextValue;

  @property({ type: Boolean }) showSessionHint = true;

  /**
   * Enables the roomy, conversation-first composer used by the Electron host.
   * The extension keeps its existing compact panel unless the desktop shell
   * opts in explicitly.
   */
  @property({ type: Boolean, attribute: 'desktop-host', reflect: true })
  desktopHost = false;

  /** Reference to instruction textarea for paste handling */
  @query('#instruction')
  private instructionTextarea?: HTMLElement;

  private fileDrop = new FileDropController(this, (paths) =>
    postDroppedFiles(paths),
  );

  /** Compact select sizing on the desktop composer; default size otherwise. */
  private get selectSize(): 'xs' | typeof nothing {
    return this.desktopHost ? 'xs' : nothing;
  }

  private renderSessionHint(session: SessionContextValue): unknown {
    if (!this.showSessionHint) return nothing;

    const hintKey = resolveSessionHintKey(session);
    const copy = SESSION_HINT_COPY[hintKey];
    // `keyed` forces the wrapping div to be re-created when the hint key
    // changes, which restarts the `session-hint-fade` CSS animation defined
    // in the host stylesheet so copy swaps cross-fade instead of jump-cutting.
    return keyed(
      hintKey,
      html`
        <wa-callout
          class="session-hint"
          variant="brand"
          role="note"
          data-hint-key=${hintKey}
          aria-label=${copy.ariaLabel}
        >
          <span class="session-hint-lede">${copy.lede}</span>
          <span class="session-hint-body">
            ${copy.body}
            ${
              copy.time
                ? html`<span class="session-hint-time">${copy.time}</span>`
                : nothing
            }
          </span>
          ${renderIconActionButton({
            id: 'dismissSessionHintButton',
            icon: 'xmark',
            label: 'Dismiss this reminder',
            tooltip: 'Dismiss this reminder',
            className: 'session-hint-dismiss',
            onClick: this.handleDismissSessionHint,
          })}
        </wa-callout>
      `,
    );
  }

  private handleDismissSessionHint(): void {
    this.dispatchEvent(MainViewEvents.dismissSessionHint());
  }

  private handleSessionTypeChange(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    const value =
      target?.value === SESSION_TYPES.WORKFLOW
        ? SESSION_TYPES.WORKFLOW
        : SESSION_TYPES.TOOL_USE;
    this.dispatchEvent(MainViewEvents.sessionTypeChange({ value }));
  }

  private handleLaunchTargetChange(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    const value: LaunchTarget = target?.value === 'team' ? 'team' : 'agent';
    this.dispatchEvent(MainViewEvents.launchTargetChange({ value }));
  }

  private handleDesktopLaunchModeChange(event: Event): void {
    const select = event.currentTarget as WaSelect | null;
    const mode = typeof select?.value === 'string' ? select.value : '';

    if (mode === 'workflow') {
      this.dispatchEvent(
        MainViewEvents.sessionTypeChange({ value: SESSION_TYPES.WORKFLOW }),
      );
      return;
    }
    this.dispatchEvent(
      MainViewEvents.sessionTypeChange({ value: SESSION_TYPES.TOOL_USE }),
    );
    this.dispatchEvent(
      MainViewEvents.launchTargetChange({
        value: mode === 'team' ? 'team' : 'agent',
      }),
    );
  }

  private handleAgentChange(event: Event): void {
    const select = event.currentTarget as (WaSelect & HTMLElement) | null;
    if (!select) return;
    const sessionType = select.dataset.sessionType as SessionType;
    const value = typeof select.value === 'string' ? select.value : '';
    if (value === BROWSE_ALL_AGENTS_OPTION_VALUE) {
      // Not a real agent: keep the current selection and open the catalog.
      const session = this.sessionData;
      select.value = session?.agent[sessionType] ?? '';
      this.dispatchEvent(MainViewEvents.browseAllAgents());
      return;
    }
    this.dispatchEvent(MainViewEvents.agentChange({ sessionType, value }));
  }

  private handleTeamChange(event: Event): void {
    const select = event.currentTarget as WaSelect | null;
    if (!select) return;
    const value = typeof select.value === 'string' ? select.value : '';
    if (value === MANAGE_TEAMS_OPTION_VALUE) {
      select.value = this.sessionData?.selectedTeamId ?? '';
      this.dispatchEvent(MainViewEvents.manageTeams());
      return;
    }
    this.dispatchEvent(MainViewEvents.teamChange({ value }));
  }

  private handleModelChange(event: Event): void {
    this.dispatchEvent(
      MainViewEvents.modelChange({ value: readSelectValue(event) }),
    );
  }

  private handleWorkingDirectoryChange(event: Event): void {
    this.dispatchEvent(
      MainViewEvents.workingDirectoryChange({
        value: readSelectValue(event),
      }),
    );
  }

  private handleInput(event: Event): void {
    const value = (event.currentTarget as HTMLTextAreaElement).value;
    this.dispatchEvent(MainViewEvents.instructionInput({ value }));
  }

  /** Handle paste event on instruction textarea */
  private handleInstructionPaste = async (event: Event): Promise<void> => {
    if (!(event instanceof ClipboardEvent)) return;
    if (!this.instructionTextarea) return;
    const handled = await handleImagePaste(event, this.instructionTextarea);
    if (handled) {
      this.dispatchEvent(
        MainViewEvents.instructionInput({
          value: getTextareaValue(this.instructionTextarea),
        }),
      );
    }
  };

  private handleActionClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-action]',
    );
    const action = button?.dataset.action;
    if (action) {
      this.dispatchEvent(MainViewEvents.panelAction({ action }));
    }
  }

  private canExecute(session = this.sessionData): boolean {
    if (!session?.instruction.trim() || !session.model) return false;
    if (isTeamLaunch(session)) return Boolean(session.selectedTeamId);
    return Boolean(selectedAgentId(session));
  }

  private executeTooltip(session: SessionContextValue): string {
    if (!session.instruction.trim()) return 'Enter a request to send';
    if (!session.model) return 'Choose a model before sending';
    if (isTeamLaunch(session) && !session.selectedTeamId) {
      return 'Choose a team before sending';
    }
    if (!selectedAgentId(session)) return 'Choose an agent before sending';
    return this.desktopHost
      ? 'Send (Enter) · New line (Shift+Enter)'
      : `Run agent (${this.executeShortcutLabel})`;
  }

  private handleExecute(): void {
    if (!this.canExecute()) return;
    this.dispatchEvent(MainViewEvents.execute());
  }

  /**
   * Desktop follows chat-composer keyboard conventions: Enter sends while
   * Shift+Enter inserts a newline. Cmd/Ctrl+Enter also sends because those
   * modifiers are commonly used by users coming from editor-based chat tools.
   * The extension retains its registered command keybinding unchanged.
   */
  private handleInstructionKeydown(event: KeyboardEvent): void {
    if (
      !this.desktopHost ||
      event.defaultPrevented ||
      event.isComposing ||
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    this.handleExecute();
  }

  /**
   * Keyboard-shortcut label shown in the Execute button. Matches the
   * `texra.execute` keybinding declared in the extension's package.json
   * (cmd+option+e on macOS, ctrl+alt+e elsewhere).
   */
  private get executeShortcutLabel(): string {
    const isMac =
      typeof navigator !== 'undefined' &&
      /Mac|iPhone|iPod|iPad/.test(navigator.platform || '');
    return isMac ? '⌘⌥E' : 'Ctrl+Alt+E';
  }

  private handleAgentSettings(): void {
    this.dispatchEvent(MainViewEvents.agentSettings());
  }

  private handleTeamSettings(): void {
    this.dispatchEvent(MainViewEvents.teamSettings());
  }

  private handleModelSettings(): void {
    this.dispatchEvent(MainViewEvents.modelSettings());
  }

  private handleAgentFocus(): void {
    this.dispatchEvent(
      MainViewEvents.focusInstruction({
        key: 'agentPicker',
        text: 'Select which agent will handle your request.',
      }),
    );
  }

  private handleModelFocus(): void {
    const teamSelected = isTeamLaunch(this.sessionData);
    this.dispatchEvent(
      MainViewEvents.focusInstruction({
        key: 'modelPicker',
        text: teamSelected
          ? 'Choose the AI model used by the team lead.'
          : 'Choose the AI model used by the selected agent.',
      }),
    );
  }

  private renderAgentSelect(session: SessionContextValue): TemplateResult {
    const agent =
      session.sessionType === SESSION_TYPES.WORKFLOW
        ? {
            id: 'workflowAgent',
            sessionType: 'workflow',
            ariaLabel: 'Workflow agent',
            options: session.agentOptions.workflow,
            value: session.agent.workflow,
          }
        : {
            id: 'toolUseAgent',
            sessionType: 'toolUse',
            ariaLabel: 'Tool-use agent',
            options: session.agentOptions.toolUse,
            value: session.agent.toolUse,
          };
    return html`
      <wa-select
        id=${agent.id}
        class="agent-select"
        data-session-type=${agent.sessionType}
        aria-label=${agent.ariaLabel}
        size=${this.selectSize}
        placement="top"
        placeholder="Agent…"
        .value=${agent.value}
        @focus=${this.handleAgentFocus}
        @change=${this.handleAgentChange}
      >
        ${renderAgentOptions(agent.options, {
          includeBrowseAll: true,
        })}
      </wa-select>
    `;
  }

  private renderLauncherPicker(session: SessionContextValue): TemplateResult {
    if (session.sessionType === SESSION_TYPES.WORKFLOW) {
      return html`
        <div class="select-group agent-select-group agent-model-select-group">
          ${renderIconActionButton({
            id: 'agentSettingsButton',
            icon: 'wand-magic-sparkles',
            label: 'Agent settings',
            tooltip: 'Agent settings',
            className: 'settings-button',
            onClick: this.handleAgentSettings,
          })}
          ${this.renderAgentSelect(session)}
        </div>
      `;
    }

    const isTeam = isTeamLaunch(session);
    return html`
      <div
        class="select-group agent-select-group agent-model-select-group launcher-picker-fade ${
          isTeam ? 'team-picker-visible' : 'agent-picker-visible'
        }"
      >
        <div
          class="launcher-picker-pane team-picker-pane"
          ?inert=${!isTeam}
          aria-hidden=${isTeam ? 'false' : 'true'}
        >
          ${renderIconActionButton({
            id: 'teamSettingsButton',
            icon: 'building',
            label: 'Team settings',
            tooltip: 'Team settings',
            className: 'settings-button',
            onClick: this.handleTeamSettings,
          })}
          <wa-select
            id="teamPicker"
            class="agent-select team-select"
            aria-label="Team"
            size=${this.selectSize}
            placement="top"
            placeholder="Team…"
            .value=${session.selectedTeamId}
            @change=${this.handleTeamChange}
          >
            ${renderTeamOptions(session.teamOptions, {
              includeManageTeams: true,
            })}
          </wa-select>
        </div>
        <div
          class="launcher-picker-pane agent-picker-pane"
          ?inert=${isTeam}
          aria-hidden=${isTeam ? 'true' : 'false'}
        >
          ${renderIconActionButton({
            id: 'agentSettingsButton',
            icon: 'wand-magic-sparkles',
            label: 'Agent settings',
            tooltip: 'Agent settings',
            className: 'settings-button',
            onClick: this.handleAgentSettings,
          })}
          ${this.renderAgentSelect(session)}
        </div>
      </div>
    `;
  }

  private renderDesktopLaunchMode(
    session: SessionContextValue,
  ): TemplateResult {
    return html`
      <wa-select
        id="desktopLaunchMode"
        class="desktop-launch-mode"
        aria-label="Run mode"
        size="xs"
        placement="top"
        .value=${getDesktopLaunchMode(session)}
        @change=${this.handleDesktopLaunchModeChange}
      >
        ${waIcon('diagram-project', { slot: 'start' })}
        <wa-option value="interactive">Interactive</wa-option>
        <wa-option value="team">Team</wa-option>
        <wa-option value="workflow">Workflow</wa-option>
      </wa-select>
    `;
  }

  private renderWorkspaceRootSelect(
    session: SessionContextValue,
  ): TemplateResult | typeof nothing {
    if (session.workspaceRootOptions.length < 2) return nothing;

    return html`
      <div class="select-group workspace-root-control">
        <wa-select
          id="workingDirectory"
          class="workspace-root-select"
          aria-label="Working directory"
          size=${this.selectSize}
          placement="top"
          title=${session.workingDirectory}
          .value=${session.workingDirectory}
          @change=${this.handleWorkingDirectoryChange}
        >
          ${waIcon('folder-tree', { slot: 'start' })}
          ${session.workspaceRootOptions.map(
            (option) => html`
              <wa-option value=${option.value} title=${option.value}>
                ${option.label}
              </wa-option>
            `,
          )}
        </wa-select>
      </div>
    `;
  }

  override render(): TemplateResult | typeof nothing {
    const session = this.sessionData;
    if (!session) {
      return nothing;
    }
    const sessionTypeToggle = html`
      <div class="instruction-session-toggle">
        <wa-radio-group
          id="sessionTypeToggle"
          aria-label="Choose the session type"
          orientation="horizontal"
          .value=${session.sessionType}
          @change=${this.handleSessionTypeChange}
        >
          <wa-radio
            id="sessionTypeToolUse"
            value="toolUse"
            data-session-type="toolUse"
            appearance="default"
          >
            Interactive
          </wa-radio>
          <wa-radio
            id="sessionTypeWorkflow"
            value="workflow"
            data-session-type="workflow"
            appearance="default"
          >
            Workflow
          </wa-radio>
        </wa-radio-group>
        <wa-tooltip for="sessionTypeToolUse">
          ${getSessionTitle(SESSION_TYPES.TOOL_USE)}
        </wa-tooltip>
        <wa-tooltip for="sessionTypeWorkflow">
          ${getSessionTitle(SESSION_TYPES.WORKFLOW)}
        </wa-tooltip>
      </div>
    `;
    const launchTargetToggle =
      !this.desktopHost && session.sessionType === SESSION_TYPES.TOOL_USE
        ? html`
            <div class="select-group launch-target-group">
              <wa-radio-group
                id="launchTargetToggle"
                aria-label="Choose who runs this request"
                orientation="horizontal"
                .value=${session.launchTarget}
                @change=${this.handleLaunchTargetChange}
              >
                <wa-radio
                  id="launchTargetAgent"
                  value="agent"
                  appearance="default"
                >
                  Agent
                </wa-radio>
                <wa-radio
                  id="launchTargetTeam"
                  value="team"
                  appearance="default"
                >
                  Team
                </wa-radio>
              </wa-radio-group>
            </div>
          `
        : nothing;

    return html`
      <div
        class=${classMap({
          'instruction-box': true,
          'desktop-composer': this.desktopHost,
          'drop-active': this.fileDrop.isDragActive,
        })}
        @dragenter=${this.fileDrop.handleDragEnter}
        @dragover=${this.fileDrop.handleDragOver}
        @dragleave=${this.fileDrop.handleDragLeave}
        @drop=${this.fileDrop.handleDrop}
      >
        <div class="instruction-header">
          <div class="instruction-header-leading">
            ${
              this.desktopHost
                ? html`
                    <span class="desktop-drop-affordance">
                      <span class="icon-surface is-size-m">
                        ${waIcon('file-circle-plus')}
                      </span>
                    </span>
                  `
                : sessionTypeToggle
            }
          </div>
          <div
            class="instruction-header-actions"
            @click=${this.handleActionClick}
          >
            ${
              session.debugMode
                ? html`
                    ${renderIconActionButton({
                      id: 'packButton',
                      icon: 'box-archive',
                      label: 'Pack output to History',
                      tooltip:
                        'Pack the output for this agent into the History folder',
                      action: 'pack',
                    })}
                    ${renderIconActionButton({
                      id: 'cleanButton',
                      icon: 'trash',
                      label: 'Clean output',
                      tooltip: 'Clean the output for this agent',
                      action: 'clean',
                    })}
                  `
                : nothing
            }
            ${renderIconActionButton({
              id: 'magicPolishButton',
              icon: 'wand-magic-sparkles',
              label: 'Polish instruction',
              tooltip: 'Polish instruction text with AI',
              busy: session.isPolishing,
              action: 'polish',
            })}
            ${renderIconActionButton({
              id: 'recordInstructionButton',
              icon: session.isRecording ? 'circle-stop' : 'microphone',
              label: session.isRecording
                ? 'Stop recording'
                : 'Record instruction',
              pressed: session.isRecording,
              tooltip: session.isRecording
                ? 'Stop recording'
                : 'Record instruction with microphone',
              className: session.isRecording ? 'recording' : '',
              action: 'record',
            })}
          </div>
        </div>
        ${this.renderSessionHint(session)}
        <!-- A light-DOM <label for>, not a host aria-label and not WebAwesome's
             label slot: wa-textarea is form-associated, so this names the inner
             control for real while adding no shadow-DOM label chrome that could
             shift the composer's layout. -->
        <label class="visually-hidden" for="instruction">Instruction</label>
        <wa-textarea
          id="instruction"
          rows=${this.desktopHost ? '4' : '10'}
          resize="none"
          enterkeyhint=${this.desktopHost ? 'send' : nothing}
          placeholder=${session.placeholder}
          .value=${session.instruction}
          @input=${this.handleInput}
          @keydown=${this.handleInstructionKeydown}
          @paste=${this.handleInstructionPaste}
        ></wa-textarea>
        <div class="instruction-controls">
          <div class="model-selection-footer">
            ${this.renderWorkspaceRootSelect(session)}
            ${
              this.desktopHost
                ? html`
                    <div class="desktop-mode-controls">
                      ${this.renderDesktopLaunchMode(session)}
                    </div>
                  `
                : launchTargetToggle
            }
            ${this.renderLauncherPicker(session)}
            <div
              class="select-group model-select-group agent-model-select-group"
            >
              ${renderIconActionButton({
                id: 'modelSettingsButton',
                icon: 'robot',
                label: 'Model settings',
                tooltip: 'Model settings',
                className: 'settings-button',
                onClick: this.handleModelSettings,
              })}
              <wa-select
                id="model"
                class="model-select"
                placement="top"
                aria-label=${isTeamLaunch(session) ? 'Lead model' : 'Model'}
                size=${this.selectSize}
                placeholder="Select model…"
                title=${
                  session.modelOptions.find((o) => o.value === session.model)
                    ?.hint || nothing
                }
                .value=${session.model}
                @focus=${this.handleModelFocus}
                @change=${this.handleModelChange}
              >
                ${renderModelOptions(session.modelOptions)}
              </wa-select>
            </div>
          </div>
          ${renderIconActionButton({
            id: 'executeButton',
            icon: 'arrow-up',
            label: this.desktopHost ? 'Send request' : 'Run agent',
            tooltip: this.executeTooltip(session),
            className: 'composer-primary-action',
            appearance: 'filled',
            size: 'l',
            disabled: !this.canExecute(session),
            onClick: this.handleExecute,
          })}
        </div>
        <div class="visually-hidden" aria-live="polite">
          ${session.statusAnnouncement}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'instruction-panel': InstructionPanel;
  }
}
