/**
 * InstructionPanel component for MainView instruction input.
 *
 * Renders the instruction textarea with session type toggle,
 * action buttons, agent/model selectors, and execute button.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Local imports - shared utils
import { markOptionAsSelected, withPlaceholder } from '@shared/utils/dropdown';

// Local imports - main view
import { MainViewEvents } from '../events';
import { SESSION_TYPES, type SessionType } from '../constants';

// Local imports - shared schemas
import type {
  ActionDetail,
  AgentChangeDetail,
  InstructionChangeDetail,
  ModelChangeDetail,
  SessionTypeChangeDetail,
} from '@shared/schemas';

@customElement('instruction-panel')
export class InstructionPanel extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    .instruction-box {
      display: flex;
      flex-direction: column;
      padding: var(--spacing-medium);
      background-color: var(--background-color);
      border-radius: var(--border-radius);
      margin-bottom: var(--spacing-large);
    }

    .instruction-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--spacing-medium);
      margin-bottom: var(--spacing-small);
      height: var(--height-control);
    }

    .instruction-header-leading {
      display: flex;
      gap: var(--spacing-medium);
      align-items: center;
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
      font-family: var(--vscode-editor-font-family);
      font-size: var(--font-size);
    }

    .instruction-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-small);
      margin-top: var(--spacing-small);
    }

    .model-selection-footer {
      display: flex;
      align-items: center;
      gap: var(--spacing-medium);
      flex: 1;
    }

    .select-group {
      display: flex;
      align-items: center;
      gap: var(--spacing-tiny);
    }

    .agent-select-group {
      flex: 1;
      min-width: 0;
    }

    .agent-select-controls {
      flex: 1;
      min-width: 0;
    }

    .agent-select-dropdowns {
      position: relative;
      width: 100%;
    }

    .agent-select {
      width: 100%;
    }

    .agent-select--hidden {
      display: none;
    }

    .agent-select--active {
      display: block;
    }

    .clickable {
      cursor: pointer;
    }

    .clickable:hover {
      color: var(--vscode-foreground);
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
        opacity: 0.5;
      }
    }
  `;

  /** Current session type */
  @property({ type: String }) sessionType: SessionType = SESSION_TYPES.TOOL_USE;

  /** Current instruction text */
  @property({ type: String }) instruction = '';

  /** Instruction placeholder */
  @property({ type: String }) placeholder = '';

  /** Current workflow agent */
  @property({ type: String }) workflowAgent = '';

  /** Current tool-use agent */
  @property({ type: String }) toolUseAgent = '';

  /** Current model */
  @property({ type: String }) model = '';

  /** Workflow agent options HTML */
  @property({ type: String }) workflowAgentOptionsHtml = '';

  /** Tool-use agent options HTML */
  @property({ type: String }) toolUseAgentOptionsHtml = '';

  /** Model options HTML */
  @property({ type: String }) modelOptionsHtml = '';

  /** Whether recording is active */
  @property({ type: Boolean }) isRecording = false;

  /** Whether polishing is active */
  @property({ type: Boolean }) isPolishing = false;

  /** Whether debug mode is enabled */
  @property({ type: Boolean }) debugMode = false;

  private createEvent<T>(type: string, detail: T): CustomEvent<T> {
    return new CustomEvent(type, { detail, bubbles: true, composed: true });
  }

  private handleSessionTypeChange(value: SessionType): void {
    this.dispatchEvent(
      this.createEvent<SessionTypeChangeDetail>('session-type-change', {
        value,
      }),
    );
  }

  private handleAgentChange(sessionType: SessionType, value: string): void {
    this.dispatchEvent(
      this.createEvent<AgentChangeDetail>('agent-change', {
        sessionType,
        value,
      }),
    );
  }

  private handleModelChange(value: string): void {
    this.dispatchEvent(
      this.createEvent<ModelChangeDetail>('model-change', { value }),
    );
  }

  private handleInstructionInput(value: string): void {
    this.dispatchEvent(
      this.createEvent<InstructionChangeDetail>('instruction-input', { value }),
    );
  }

  private handleAction(action: string): void {
    this.dispatchEvent(
      this.createEvent<ActionDetail>('panel-action', { action }),
    );
  }

  private handleExecute(): void {
    this.dispatchEvent(
      new CustomEvent('execute', { bubbles: true, composed: true }),
    );
  }

  private handleAgentSettings(): void {
    this.dispatchEvent(
      new CustomEvent('agent-settings', { bubbles: true, composed: true }),
    );
  }

  private handleModelSettings(): void {
    this.dispatchEvent(
      new CustomEvent('model-settings', { bubbles: true, composed: true }),
    );
  }

  private handleFocus(key: string, text: string): void {
    this.dispatchEvent(MainViewEvents.focusInstruction({ key, text }));
  }

  override render(): TemplateResult {
    const workflowOptions = markOptionAsSelected(
      withPlaceholder(
        this.workflowAgentOptionsHtml,
        '<vscode-option value="">Select agent</vscode-option>',
      ),
      this.workflowAgent,
    );
    const toolUseOptions = markOptionAsSelected(
      withPlaceholder(
        this.toolUseAgentOptionsHtml,
        '<vscode-option value="">Select agent</vscode-option>',
      ),
      this.toolUseAgent,
    );
    const modelOptions = markOptionAsSelected(
      withPlaceholder(
        this.modelOptionsHtml,
        '<vscode-option value="">Select model</vscode-option>',
      ),
      this.model,
    );

    return html`
      <div class="instruction-box">
        <div class="instruction-header">
          <div class="instruction-header-leading">
            <div class="instruction-session-toggle">
              <input
                type="hidden"
                id="sessionType"
                .value=${this.sessionType}
              />
              <vscode-radio-group
                id="sessionTypeToggle"
                aria-label="Choose the session type"
                orientation="horizontal"
                .value=${this.sessionType}
                @change=${(event: Event) => {
                  const target = event.target as HTMLInputElement | null;
                  const nextValue =
                    target?.value === SESSION_TYPES.WORKFLOW
                      ? SESSION_TYPES.WORKFLOW
                      : SESSION_TYPES.TOOL_USE;
                  this.handleSessionTypeChange(nextValue);
                }}
              >
                <vscode-radio
                  value="toolUse"
                  data-session-type="toolUse"
                  ?checked=${this.sessionType === SESSION_TYPES.TOOL_USE}
                  title="Chat agents execute commands and scripts"
                >
                  Chat
                </vscode-radio>
                <vscode-radio
                  value="workflow"
                  data-session-type="workflow"
                  ?checked=${this.sessionType === SESSION_TYPES.WORKFLOW}
                  title="Workflow agents automate document editing tasks"
                >
                  Workflow
                </vscode-radio>
              </vscode-radio-group>
            </div>
          </div>
          <vscode-toolbar-container class="instruction-header-actions">
            <vscode-toolbar-button
              id="packButton"
              icon="archive"
              label="Pack output to History"
              title="Pack the output for this agent into the History folder"
              style=${this.debugMode ? '' : 'display: none'}
              @click=${() => this.handleAction('pack')}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="cleanButton"
              icon="trash"
              label="Clean output"
              title="Clean the output for this agent"
              style=${this.debugMode ? '' : 'display: none'}
              @click=${() => this.handleAction('clean')}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="magicPolishButton"
              icon="sparkle"
              label="Polish instruction"
              title="Polish instruction text with AI"
              @click=${() => this.handleAction('polish')}
            ></vscode-toolbar-button>
            <vscode-progress-ring
              id="polishProgressContainer"
              style=${this.isPolishing
                ? 'display: block; width: 16px; height: 16px'
                : 'display: none'}
            ></vscode-progress-ring>
            <vscode-toolbar-button
              id="recordInstructionButton"
              icon=${this.isRecording ? 'stop-circle' : 'mic'}
              class=${this.isRecording ? 'recording' : ''}
              label="Record instruction"
              title=${this.isRecording
                ? 'Stop recording'
                : 'Record instruction with microphone'}
              @click=${() => this.handleAction('record')}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="eraseInstructionButton"
              icon="clear-all"
              label="Erase instruction"
              title="Erase instruction"
              @click=${() => this.handleAction('erase')}
            ></vscode-toolbar-button>
          </vscode-toolbar-container>
        </div>
        <vscode-textarea
          id="instruction"
          rows="10"
          resize="none"
          placeholder=${this.placeholder}
          .value=${this.instruction}
          @input=${(event: Event) => {
            const target = event.target as HTMLTextAreaElement;
            this.handleInstructionInput(target.value);
          }}
        ></vscode-textarea>
        <div class="instruction-controls">
          <div class="model-selection-footer">
            <div class="select-group agent-select-group">
              <i
                id="agentSettingsButton"
                class="codicon codicon-sparkle clickable"
                title="Agent settings"
                @click=${this.handleAgentSettings}
              ></i>
              <div class="agent-select-controls">
                <div class="agent-select-dropdowns">
                  <vscode-single-select
                    id="workflowAgent"
                    class=${classMap({
                      'agent-select': true,
                      'agent-select--hidden':
                        this.sessionType !== SESSION_TYPES.WORKFLOW,
                      'agent-select--active':
                        this.sessionType === SESSION_TYPES.WORKFLOW,
                    })}
                    data-session-type="workflow"
                    aria-label="Workflow agent"
                    tabindex=${this.sessionType === SESSION_TYPES.WORKFLOW
                      ? 0
                      : -1}
                    aria-hidden=${this.sessionType === SESSION_TYPES.WORKFLOW
                      ? 'false'
                      : 'true'}
                    position="above"
                    .value=${this.workflowAgent}
                    @focus=${() =>
                      this.handleFocus(
                        'agentPicker',
                        'Select which agent will handle your request.',
                      )}
                    @change=${(event: Event) => {
                      const target = event.currentTarget as HTMLInputElement;
                      this.handleAgentChange(
                        SESSION_TYPES.WORKFLOW,
                        target.value,
                      );
                    }}
                  >
                    ${unsafeHTML(workflowOptions)}
                  </vscode-single-select>
                  <vscode-single-select
                    id="toolUseAgent"
                    class=${classMap({
                      'agent-select': true,
                      'agent-select--hidden':
                        this.sessionType !== SESSION_TYPES.TOOL_USE,
                      'agent-select--active':
                        this.sessionType === SESSION_TYPES.TOOL_USE,
                    })}
                    data-session-type="toolUse"
                    aria-label="Tool-use agent"
                    position="above"
                    .value=${this.toolUseAgent}
                    @focus=${() =>
                      this.handleFocus(
                        'agentPicker',
                        'Select which agent will handle your request.',
                      )}
                    @change=${(event: Event) => {
                      const target = event.currentTarget as HTMLInputElement;
                      this.handleAgentChange(
                        SESSION_TYPES.TOOL_USE,
                        target.value,
                      );
                    }}
                  >
                    ${unsafeHTML(toolUseOptions)}
                  </vscode-single-select>
                </div>
              </div>
            </div>
            <div class="select-group">
              <i
                id="modelSettingsButton"
                class="codicon codicon-robot clickable"
                title="Model settings"
                @click=${this.handleModelSettings}
              ></i>
              <vscode-single-select
                id="model"
                position="above"
                aria-label="Model"
                .value=${this.model}
                @focus=${() =>
                  this.handleFocus(
                    'modelPicker',
                    'Choose the AI model used by the selected agent.',
                  )}
                @change=${(event: Event) => {
                  const target = event.currentTarget as HTMLInputElement;
                  this.handleModelChange(target.value);
                }}
              >
                ${unsafeHTML(modelOptions)}
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
