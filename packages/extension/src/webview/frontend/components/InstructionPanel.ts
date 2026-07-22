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
import type { ModelOptionData } from '@shared/schemas';

// Local imports - shared styles
import { designTokens } from '@shared/styles';
import { commonViewStyles } from '@shared/styles/commonViewStyles';
import { selectStyles } from '@shared/styles/selectStyles';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - shared utils
import {
  BROWSE_ALL_AGENTS_OPTION_VALUE,
  readSelectValue,
  renderAgentOptions,
  renderModelOptions,
} from '@shared/utils/selectTemplates';
import { getTextareaValue } from '@shared/utils/textarea';
import { renderIconActionButton } from '@shared/wa/actionButtons';

// Local imports - main view
import { MainViewEvents } from '../events';
import { FileDropController, postDroppedFiles } from '../fileDropHandler';
import { handleImagePaste } from '../pasteHandler';
import { SESSION_TYPES, type SessionType } from '../constants';
import {
  sessionContext,
  type SessionContextValue,
} from '../contexts/mainViewContexts';
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

type SessionHintKey = SessionType | 'orchestrator';

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
    time: 'E.g., “use polish on the intro, then review the math” — or leave it blank. Approve tasks in Progress as they arrive.',
    ariaLabel: 'About orchestrator mode',
  },
};

function getSessionTitle(type: SessionType): string {
  const copy = SESSION_HINT_COPY[type];
  return `${copy.lede} ${copy.body}`;
}

function resolveSessionHintKey(session: SessionContextValue): SessionHintKey {
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

  /** Reference to instruction textarea for paste handling */
  @query('#instruction')
  private instructionTextarea?: HTMLElement;

  private fileDrop = new FileDropController(this, (paths) =>
    postDroppedFiles(paths),
  );

  /** Get the tooltip for the model dropdown based on the selected model's hint. */
  private getModelTooltip(
    options: ModelOptionData[],
    selectedValue: string,
  ): string {
    return options.find((o) => o.value === selectedValue)?.hint ?? '';
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
            <span class="session-hint-time">${copy.time}</span>
          </span>
          ${renderIconActionButton({
            id: 'dismissSessionHintButton',
            icon: 'close',
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

  private handleAgentChange(event: Event): void {
    const select = event.currentTarget as (WaSelect & HTMLElement) | null;
    if (!select) return;
    const sessionType = select.dataset.sessionType as SessionType;
    const value = typeof select.value === 'string' ? select.value : '';
    if (value === BROWSE_ALL_AGENTS_OPTION_VALUE) {
      // Not a real agent: keep the current selection and open the catalog.
      const session = this.sessionData;
      select.value =
        (sessionType === SESSION_TYPES.WORKFLOW
          ? session?.workflowAgent
          : session?.toolUseAgent) ?? '';
      this.dispatchEvent(MainViewEvents.browseAllAgents());
      return;
    }
    this.dispatchEvent(MainViewEvents.agentChange({ sessionType, value }));
  }

  private handleModelChange(event: Event): void {
    this.dispatchEvent(
      MainViewEvents.modelChange({ value: readSelectValue(event) }),
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
      // Dispatch additional event so parent can save state
      this.dispatchEvent(MainViewEvents.instructionPaste());
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

  private handleExecute(): void {
    this.dispatchEvent(MainViewEvents.execute());
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
    this.dispatchEvent(
      MainViewEvents.focusInstruction({
        key: 'modelPicker',
        text: 'Choose the AI model used by the selected agent.',
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
            options: session.workflowAgentOptions,
            value: session.workflowAgent,
          }
        : {
            id: 'toolUseAgent',
            sessionType: 'toolUse',
            ariaLabel: 'Tool-use agent',
            options: session.toolUseAgentOptions,
            value: session.toolUseAgent,
          };
    return html`
      <wa-select
        id=${agent.id}
        class="agent-select"
        data-session-type=${agent.sessionType}
        aria-label=${agent.ariaLabel}
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

  override render(): TemplateResult | typeof nothing {
    const session = this.sessionData;
    if (!session) {
      return nothing;
    }
    return html`
      <div
        class=${classMap({
          'instruction-box': true,
          'drop-active': this.fileDrop.isDragActive,
        })}
        @dragenter=${this.fileDrop.handleDragEnter}
        @dragover=${this.fileDrop.handleDragOver}
        @dragleave=${this.fileDrop.handleDragLeave}
        @drop=${this.fileDrop.handleDrop}
      >
        <div class="instruction-header">
          <div class="instruction-header-leading">
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
                >
                  Interactive
                </wa-radio>
                <wa-radio
                  id="sessionTypeWorkflow"
                  value="workflow"
                  data-session-type="workflow"
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
                      icon: 'archive',
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
              icon: 'sparkle',
              label: 'Polish instruction',
              tooltip: 'Polish instruction text with AI',
              busy: session.isPolishing,
              action: 'polish',
            })}
            ${renderIconActionButton({
              id: 'recordInstructionButton',
              icon: session.isRecording ? 'stop-circle' : 'mic',
              label: 'Record instruction',
              tooltip: session.isRecording
                ? 'Stop recording'
                : 'Record instruction with microphone',
              className: session.isRecording ? 'recording' : '',
              action: 'record',
            })}
            ${renderIconActionButton({
              id: 'eraseInstructionButton',
              icon: 'clear-all',
              label: 'Erase instruction',
              tooltip: 'Erase instruction',
              action: 'erase',
            })}
          </div>
        </div>
        ${this.renderSessionHint(session)}
        <wa-textarea
          id="instruction"
          rows="10"
          resize="none"
          placeholder=${session.placeholder}
          .value=${session.instruction}
          @input=${this.handleInput}
          @paste=${this.handleInstructionPaste}
        ></wa-textarea>
        <div class="instruction-controls">
          <div class="model-selection-footer">
            <div
              class="select-group agent-select-group agent-model-select-group"
            >
              ${renderIconActionButton({
                id: 'agentSettingsButton',
                icon: 'sparkle',
                label: 'Agent settings',
                tooltip: 'Agent settings',
                className: 'settings-button',
                onClick: this.handleAgentSettings,
              })}
              ${this.renderAgentSelect(session)}
            </div>
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
                aria-label="Model"
                placeholder="Select model…"
                title=${
                  this.getModelTooltip(session.modelOptions, session.model) ||
                  nothing
                }
                .value=${session.model}
                @focus=${this.handleModelFocus}
                @change=${this.handleModelChange}
              >
                ${renderModelOptions(session.modelOptions)}
              </wa-select>
            </div>
          </div>
          <wa-button
            id="executeButton"
            class="execute-button"
            appearance="filled"
            variant="brand"
            @click=${this.handleExecute}
          >
            ${waIcon('play', { slot: 'start' })}
            <span class="execute-button__label">Run</span>
          </wa-button>
          <wa-tooltip for="executeButton">
            Execute (${this.executeShortcutLabel})
          </wa-tooltip>
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
