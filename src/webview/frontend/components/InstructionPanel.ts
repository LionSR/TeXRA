/**
 * InstructionPanel component for MainView instruction input.
 *
 * Renders the instruction textarea with session type toggle,
 * action buttons, agent/model selectors, and execute button.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, query } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';

// Local imports - shared schemas and types
import type { AgentOptionData } from '@shared/schemas';

// Local imports - shared styles
import { designTokens } from '@shared/styles';
import { commonViewStyles } from '@shared/styles/commonViewStyles';
import { selectStyles } from '@shared/styles/selectStyles';

// Local imports - shared utils
import {
  renderAgentOptions,
  renderModelOptions,
} from '@shared/utils/selectTemplates';
import { getTextareaValue } from '@shared/utils/textarea';

// Local imports - main view
import { MainViewEvents } from '../events';
import { handleImagePaste } from '../pasteHandler';
import { SESSION_TYPES, type SessionType } from '../constants';
import {
  sessionContext,
  type SessionContextValue,
} from '../contexts/mainViewContexts';

@customElement('instruction-panel')
export class InstructionPanel extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    selectStyles,
    css`
      :host {
        display: block;
      }

      .instruction-box {
        display: flex;
        flex-direction: column;
        position: relative;
        padding: var(--spacing-medium);
        background-color: var(--background-color);
        border-radius: var(--border-radius);
        margin-bottom: var(--spacing-large);
        box-shadow: 0 1px 4px
          color-mix(
            in srgb,
            var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3)) 50%,
            transparent
          );
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

      .instruction-session-toggle vscode-radio-group {
        display: flex;
        gap: var(--spacing-small);
      }

      .instruction-session-toggle vscode-radio {
        font-size: var(--font-size-sm);
      }

      vscode-textarea#instruction {
        width: 100%;
        margin: var(--spacing-medium) 0;
        font-family: var(--vscode-editor-font-family);
        font-size: var(--font-size);
      }

      vscode-textarea#instruction::part(control) {
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
        flex: 0 1 auto;
      }

      .model-selection-footer .select-group,
      .model-selection-footer .agent-select-group {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        flex: 0 1 auto;
      }

      .model-selection-footer .codicon,
      .model-selection-footer vscode-toolbar-button {
        display: flex;
        align-items: center;
        line-height: 1;
      }

      .model-selection-footer vscode-toolbar-button {
        min-width: var(--height-control);
        height: var(--height-control);
      }

      .agent-select-controls,
      .agent-select-dropdowns {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        flex: 0 1 auto;
        min-width: 7rem;
        max-width: 10rem;
        position: relative;
      }

      .agent-select-dropdowns select,
      .agent-select-dropdowns vscode-single-select,
      .agent-select {
        width: 100%;
      }

      .model-selection-footer .select-group select,
      .model-selection-footer .select-group vscode-single-select {
        min-width: 4rem;
        max-width: 7rem;
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
        color: var(--vscode-errorForeground);
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

  /** Reference to instruction textarea for paste handling */
  @query('#instruction')
  private instructionTextarea?: HTMLElement;

  /** Build a tooltip string for the currently selected agent. */
  private getAgentTooltip(): string {
    const session = this.sessionData;
    if (!session) return '';
    const options: AgentOptionData[] =
      session.sessionType === SESSION_TYPES.WORKFLOW
        ? session.workflowAgentOptions
        : session.toolUseAgentOptions;
    const selectedValue =
      session.sessionType === SESSION_TYPES.WORKFLOW
        ? session.workflowAgent
        : session.toolUseAgent;
    const opt = options.find((o) => o.value === selectedValue);
    return opt?.description ?? '';
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
              <vscode-radio-group
                id="sessionTypeToggle"
                aria-label="Choose the session type"
                orientation="horizontal"
                .value=${session.sessionType}
                @change=${this.handleSessionTypeChange}
              >
                <vscode-radio
                  value="toolUse"
                  data-session-type="toolUse"
                  ?checked=${session.sessionType === SESSION_TYPES.TOOL_USE}
                  title="Chat agents execute commands and scripts"
                >
                  Chat
                </vscode-radio>
                <vscode-radio
                  value="workflow"
                  data-session-type="workflow"
                  ?checked=${session.sessionType === SESSION_TYPES.WORKFLOW}
                  title="Workflow agents automate document editing tasks"
                >
                  Workflow
                </vscode-radio>
              </vscode-radio-group>
            </div>
          </div>
          <vscode-toolbar-container
            class="instruction-header-actions"
            @click=${this.handleActionClick}
          >
            <vscode-toolbar-button
              id="packButton"
              icon="archive"
              label="Pack output to History"
              title="Pack the output for this agent into the History folder"
              style=${styleMap({ display: session.debugMode ? '' : 'none' })}
              data-action="pack"
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="cleanButton"
              icon="trash"
              label="Clean output"
              title="Clean the output for this agent"
              style=${styleMap({ display: session.debugMode ? '' : 'none' })}
              data-action="clean"
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="magicPolishButton"
              icon="sparkle"
              label="Polish instruction"
              title="Polish instruction text with AI"
              ?disabled=${session.isPolishing}
              data-action="polish"
            ></vscode-toolbar-button>
            <vscode-progress-ring
              id="polishProgressContainer"
              style=${styleMap({
                width: '16px',
                height: '16px',
                opacity: session.isPolishing ? '1' : '0',
                transition: 'opacity var(--transition-normal)',
                ...(session.isPolishing ? {} : { pointerEvents: 'none' }),
              })}
            ></vscode-progress-ring>
            <vscode-toolbar-button
              id="recordInstructionButton"
              icon=${session.isRecording ? 'stop-circle' : 'mic'}
              class=${session.isRecording ? 'recording' : ''}
              label="Record instruction"
              title=${session.isRecording
                ? 'Stop recording'
                : 'Record instruction with microphone'}
              data-action="record"
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="eraseInstructionButton"
              icon="clear-all"
              label="Erase instruction"
              title="Erase instruction"
              data-action="erase"
            ></vscode-toolbar-button>
          </vscode-toolbar-container>
        </div>
        <vscode-textarea
          id="instruction"
          rows="10"
          resize="none"
          placeholder=${session.placeholder}
          .value=${session.instruction}
          @input=${this.handleInput}
          @paste=${this.handleInstructionPaste}
        ></vscode-textarea>
        <div class="instruction-controls">
          <div class="model-selection-footer">
            <div class="select-group agent-select-group">
              <vscode-toolbar-button
                id="agentSettingsButton"
                class="settings-button"
                icon="sparkle"
                label="Agent settings"
                title="Agent settings"
                @click=${this.handleAgentSettings}
              ></vscode-toolbar-button>
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
                    title=${this.getAgentTooltip() || nothing}
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
                    title=${this.getAgentTooltip() || nothing}
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
            <div class="select-group">
              <vscode-toolbar-button
                id="modelSettingsButton"
                class="settings-button"
                icon="robot"
                label="Model settings"
                title="Model settings"
                @click=${this.handleModelSettings}
              ></vscode-toolbar-button>
              <vscode-single-select
                id="model"
                position="above"
                aria-label="Model"
                .value=${session.model}
                @focus=${this.handleModelFocus}
                @change=${this.handleModelChange}
              >
                ${renderModelOptions(session.modelOptions, session.model)}
              </vscode-single-select>
            </div>
          </div>
          <vscode-button
            id="executeButton"
            icon="play"
            title="Execute"
            appearance="primary"
            @click=${this.handleExecute}
          ></vscode-button>
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
