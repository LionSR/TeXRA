/**
 * InstructionPanel component for MainView instruction input.
 *
 * Renders the instruction textarea with session type toggle,
 * action buttons, agent/model selectors, and execute button.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, property, query } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';
import '@awesome.me/webawesome/dist/components/radio/radio.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared schemas and types
import type { AgentOptionData, ModelOptionData } from '@shared/schemas';

// Local imports - shared styles
import { designTokens, codiconStyles } from '@shared/styles';
import { commonViewStyles } from '@shared/styles/commonViewStyles';
import { selectStyles } from '@shared/styles/selectStyles';

// Local imports - shared utils
import {
  renderAgentOptions,
  renderModelOptions,
} from '@shared/utils/selectTemplates';
import { getTextareaValue } from '@shared/utils/textarea';
import { renderIconActionButton } from '@shared/wa/actionButtons';

// Local imports - main view
import { MainViewEvents } from '../events';
import { handleImagePaste } from '../pasteHandler';
import { SESSION_TYPES, type SessionType } from '../constants';
import {
  sessionContext,
  type SessionContextValue,
} from '../contexts/mainViewContexts';

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
  if (session.sessionType === SESSION_TYPES.TOOL_USE) {
    const opt = session.toolUseAgentOptions.find(
      (o) => o.value === session.toolUseAgent,
    );
    if (opt?.isOrchestrator) return 'orchestrator';
  }
  return session.sessionType;
}

@customElement('instruction-panel')
export class InstructionPanel extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    selectStyles,
    css`
      :host {
        display: block;
        --agent-select-min-width: 8rem;
        --agent-select-max-width: min(13rem, calc(100vw - 9rem));
        --model-select-min-width: 8rem;
        --model-select-max-width: min(15rem, calc(100vw - 9rem));
        --agent-model-listbox-min-width: 17rem;
        --agent-model-listbox-max-width: min(
          26rem,
          calc(100vw - var(--spacing-xlarge))
        );
      }

      .instruction-box {
        display: flex;
        flex-direction: column;
        position: relative;
        padding: var(--spacing-medium);
        background-color: var(--background-color);
        border-radius: var(--border-radius);
        margin-bottom: var(--spacing-large);
        border: var(--border-thin) solid var(--color-border);
      }

      .instruction-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--spacing-medium);
        margin-bottom: var(--spacing-small);
        line-height: var(--line-height-relaxed);
        flex-wrap: wrap;
      }

      .instruction-header-leading {
        display: flex;
        gap: var(--spacing-medium);
        align-items: center;
        flex-wrap: wrap;
      }

      .instruction-header-actions {
        display: flex;
        gap: var(--spacing-tiny);
        align-items: center;
      }

      .instruction-session-toggle {
        display: flex;
        align-items: center;
      }

      .instruction-session-toggle wa-radio-group {
        display: flex;
        gap: var(--spacing-small);
      }

      .instruction-session-toggle wa-radio {
        font-size: var(--font-size-sm);
      }

      .session-hint {
        display: flex;
        gap: var(--spacing-small);
        align-items: flex-start;
        margin-top: var(--spacing-small);
        padding: var(--spacing-tiny) var(--spacing-small);
        border-left: 2px solid var(--texra-textLink-foreground);
        color: var(--texra-descriptionForeground);
        font-size: var(--font-size-sm);
        line-height: var(--line-height-relaxed);
      }

      .session-hint-lede {
        color: var(--texra-foreground);
        font-weight: 600;
        letter-spacing: 0.01em;
        white-space: nowrap;
      }

      .session-hint-body {
        flex: 1 1 auto;
      }

      .session-hint-time {
        color: var(--texra-descriptionForeground);
        opacity: 0.85;
      }

      .session-hint-dismiss {
        flex: 0 0 auto;
        margin-left: var(--spacing-tiny);
      }

      wa-textarea#instruction {
        width: 100%;
        margin: var(--spacing-medium) 0;
        font-family: var(--texra-editor-font-family);
        font-size: var(--font-size);
      }

      wa-textarea#instruction::part(textarea) {
        max-height: var(--height-xlarge);
        transition: height var(--transition-fast);
      }

      .instruction-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-small);
        flex-wrap: wrap;
        width: 100%;
      }

      .model-selection-footer {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        flex: 1 1 auto;
        flex-wrap: wrap;
        min-width: 0;
      }

      .model-selection-footer .select-group,
      .model-selection-footer .agent-select-group {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        flex: 0 1 auto;
        min-width: 0;
      }

      .model-selection-footer .agent-model-select-group {
        flex: 0 1 auto;
      }

      .model-selection-footer .agent-select-group {
        max-width: calc(
          var(--agent-select-max-width) + var(--height-control) +
            var(--spacing-small)
        );
      }

      .model-selection-footer .model-select-group {
        max-width: calc(
          var(--model-select-max-width) + var(--height-control) +
            var(--spacing-small)
        );
      }

      .model-selection-footer .codicon,
      .model-selection-footer wa-button {
        display: flex;
        align-items: center;
        line-height: 1;
      }

      .model-selection-footer wa-button {
        min-width: var(--height-control);
        height: var(--height-control);
      }

      .model-selection-footer .agent-select-controls,
      .model-selection-footer .agent-select-dropdowns {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        flex: 0 1 var(--agent-select-max-width);
        width: 100%;
        min-width: 0;
        max-width: var(--agent-select-max-width);
        position: relative;
      }

      .agent-select-dropdowns select,
      .agent-select-dropdowns vscode-single-select,
      .agent-select {
        width: 100%;
      }

      .model-selection-footer .agent-model-select-group select,
      .model-selection-footer .agent-model-select-group vscode-single-select,
      .model-selection-footer .model-select-group vscode-single-select {
        font-size: var(--font-size-sm);
      }

      .model-selection-footer .agent-select-group vscode-single-select {
        flex: 0 1 var(--agent-select-max-width);
        min-width: var(--agent-select-min-width);
        max-width: var(--agent-select-max-width);
      }

      .model-selection-footer .model-select-group vscode-single-select {
        flex: 0 1 var(--model-select-max-width);
        min-width: var(--model-select-min-width);
        max-width: var(--model-select-max-width);
      }

      .model-selection-footer .model-select::part(listbox),
      .model-selection-footer .agent-select::part(listbox) {
        min-width: var(--agent-model-listbox-min-width);
        max-width: var(--agent-model-listbox-max-width);
      }

      .agent-select--hidden {
        display: none;
      }

      .agent-select--active {
        display: block;
      }

      /* Dropdowns in footer open upward */
      vscode-single-select::part(listbox) {
        bottom: 100%;
        top: auto;
      }

      .recording {
        color: var(--texra-errorForeground);
        animation: pulse 1s infinite;
      }

      @keyframes pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: var(--opacity-disabled);
        }
      }
    `,
  ];

  @consume({ context: sessionContext, subscribe: true })
  private sessionData?: SessionContextValue;

  @property({ type: Boolean }) showSessionHint = true;

  /** Reference to instruction textarea for paste handling */
  @query('#instruction')
  private instructionTextarea?: HTMLElement;

  /** Get the tooltip for an agent dropdown based on the selected agent's description. */
  private getAgentTooltip(
    options: AgentOptionData[],
    selectedValue: string,
  ): string {
    return options.find((o) => o.value === selectedValue)?.description ?? '';
  }

  /** Get the tooltip for the model dropdown based on the selected model's hint. */
  private getModelTooltip(
    options: ModelOptionData[],
    selectedValue: string,
  ): string {
    return options.find((o) => o.value === selectedValue)?.hint ?? '';
  }

  private renderSessionHint(
    session: SessionContextValue,
  ): TemplateResult | typeof nothing {
    if (!this.showSessionHint) return nothing;

    const copy = SESSION_HINT_COPY[resolveSessionHintKey(session)];
    return html`
      <div class="session-hint" role="note" aria-label=${copy.ariaLabel}>
        <span class="session-hint-lede">${copy.lede}</span>
        <span class="session-hint-body">
          ${copy.body}
          <span class="session-hint-time">${copy.time}</span>
        </span>
        ${renderIconActionButton({
          icon: 'close',
          label: 'Dismiss this reminder',
          title: 'Dismiss this reminder',
          className: 'session-hint-dismiss',
          onClick: this.handleDismissSessionHint,
        })}
      </div>
    `;
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
    const target = event.currentTarget as HTMLSelectElement & {
      dataset: DOMStringMap;
    };
    const sessionType = target.dataset.sessionType as SessionType;
    const value = target.value;
    this.dispatchEvent(MainViewEvents.agentChange({ sessionType, value }));
  }

  private handleModelChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    this.dispatchEvent(MainViewEvents.modelChange({ value }));
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

  override render(): TemplateResult | typeof nothing {
    const session = this.sessionData;
    if (!session) {
      return nothing;
    }
    return html`
      <div class="instruction-box">
        <div class="instruction-header">
          <div class="instruction-header-leading">
            <div class="instruction-session-toggle">
              <input
                type="hidden"
                id="sessionType"
                .value=${session.sessionType}
              />
              <wa-radio-group
                id="sessionTypeToggle"
                aria-label="Choose the session type"
                orientation="horizontal"
                .value=${session.sessionType}
                @change=${this.handleSessionTypeChange}
              >
                <wa-radio
                  value="toolUse"
                  data-session-type="toolUse"
                  title=${getSessionTitle(SESSION_TYPES.TOOL_USE)}
                >
                  Interactive
                </wa-radio>
                <wa-radio
                  value="workflow"
                  data-session-type="workflow"
                  title=${getSessionTitle(SESSION_TYPES.WORKFLOW)}
                >
                  Workflow
                </wa-radio>
              </wa-radio-group>
            </div>
          </div>
          <div
            class="instruction-header-actions"
            @click=${this.handleActionClick}
          >
            <span
              style=${styleMap({ display: session.debugMode ? '' : 'none' })}
            >
              ${renderIconActionButton({
                id: 'packButton',
                icon: 'archive',
                label: 'Pack output to History',
                title: 'Pack the output for this agent into the History folder',
                action: 'pack',
              })}
            </span>
            <span
              style=${styleMap({ display: session.debugMode ? '' : 'none' })}
            >
              ${renderIconActionButton({
                id: 'cleanButton',
                icon: 'trash',
                label: 'Clean output',
                title: 'Clean the output for this agent',
                action: 'clean',
              })}
            </span>
            ${renderIconActionButton({
              id: 'magicPolishButton',
              icon: 'sparkle',
              label: 'Polish instruction',
              title: 'Polish instruction text with AI',
              disabled: session.isPolishing,
              action: 'polish',
            })}
            ${session.isPolishing
              ? html`
                  <wa-spinner
                    id="polishProgressContainer"
                    style=${styleMap({
                      fontSize: '16px',
                    })}
                  ></wa-spinner>
                `
              : nothing}
            ${renderIconActionButton({
              id: 'recordInstructionButton',
              icon: session.isRecording ? 'stop-circle' : 'mic',
              label: 'Record instruction',
              title: session.isRecording
                ? 'Stop recording'
                : 'Record instruction with microphone',
              className: session.isRecording ? 'recording' : '',
              action: 'record',
            })}
            ${renderIconActionButton({
              id: 'eraseInstructionButton',
              icon: 'clear-all',
              label: 'Erase instruction',
              title: 'Erase instruction',
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
                title: 'Agent settings',
                className: 'settings-button',
                onClick: this.handleAgentSettings,
              })}
              <div class="agent-select-controls">
                <div class="agent-select-dropdowns">
                  <vscode-single-select
                    id="workflowAgent"
                    class=${classMap({
                      'agent-select': true,
                      'agent-select--hidden':
                        session.sessionType !== SESSION_TYPES.WORKFLOW,
                      'agent-select--active':
                        session.sessionType === SESSION_TYPES.WORKFLOW,
                    })}
                    data-session-type="workflow"
                    aria-label="Workflow agent"
                    title=${this.getAgentTooltip(
                      session.workflowAgentOptions,
                      session.workflowAgent,
                    ) || nothing}
                    tabindex=${session.sessionType === SESSION_TYPES.WORKFLOW
                      ? 0
                      : -1}
                    aria-hidden=${session.sessionType === SESSION_TYPES.WORKFLOW
                      ? 'false'
                      : 'true'}
                    position="above"
                    .value=${session.workflowAgent}
                    @focus=${this.handleAgentFocus}
                    @change=${this.handleAgentChange}
                  >
                    ${renderAgentOptions(
                      session.workflowAgentOptions,
                      session.workflowAgent,
                    )}
                  </vscode-single-select>
                  <vscode-single-select
                    id="toolUseAgent"
                    class=${classMap({
                      'agent-select': true,
                      'agent-select--hidden':
                        session.sessionType !== SESSION_TYPES.TOOL_USE,
                      'agent-select--active':
                        session.sessionType === SESSION_TYPES.TOOL_USE,
                    })}
                    data-session-type="toolUse"
                    aria-label="Tool-use agent"
                    title=${this.getAgentTooltip(
                      session.toolUseAgentOptions,
                      session.toolUseAgent,
                    ) || nothing}
                    tabindex=${session.sessionType === SESSION_TYPES.TOOL_USE
                      ? 0
                      : -1}
                    aria-hidden=${session.sessionType === SESSION_TYPES.TOOL_USE
                      ? 'false'
                      : 'true'}
                    position="above"
                    .value=${session.toolUseAgent}
                    @focus=${this.handleAgentFocus}
                    @change=${this.handleAgentChange}
                  >
                    ${renderAgentOptions(
                      session.toolUseAgentOptions,
                      session.toolUseAgent,
                    )}
                  </vscode-single-select>
                </div>
              </div>
            </div>
            <div
              class="select-group model-select-group agent-model-select-group"
            >
              ${renderIconActionButton({
                id: 'modelSettingsButton',
                icon: 'robot',
                label: 'Model settings',
                title: 'Model settings',
                className: 'settings-button',
                onClick: this.handleModelSettings,
              })}
              <vscode-single-select
                id="model"
                class="model-select"
                position="above"
                aria-label="Model"
                title=${this.getModelTooltip(
                  session.modelOptions,
                  session.model,
                ) || nothing}
                .value=${session.model}
                @focus=${this.handleModelFocus}
                @change=${this.handleModelChange}
              >
                ${renderModelOptions(session.modelOptions, session.model)}
              </vscode-single-select>
            </div>
          </div>
          <wa-button
            id="executeButton"
            title="Execute"
            appearance="filled"
            variant="brand"
            @click=${this.handleExecute}
          >
            <wa-icon slot="start" library="texra" name="play"></wa-icon>
          </wa-button>
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
