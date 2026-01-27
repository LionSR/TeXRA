/**
 * InstructionPanel component for MainView instruction input.
 *
 * Renders the instruction textarea with session type toggle,
 * action buttons, agent/model selectors, and execute button.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, property, query } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Local imports - shared styles
import { selectStyles } from '@shared/styles/selectStyles';

// Local imports - shared utils
import { markOptionAsSelected, withPlaceholder } from '@shared/utils/dropdown';
import {
  renderAgentOptions,
  renderModelOptions,
  renderPlaceholder,
} from '@shared/utils/selectTemplates';

// Local imports - main view
import { MainViewEvents } from '../events';
import { handleImagePaste } from '../pasteHandler';
import { SESSION_TYPES, type SessionType } from '../constants';
import {
  sessionContext,
  type SessionContextValue,
} from '../contexts/mainViewContexts';

// Local imports - shared schemas
import type {
  ActionDetail,
  AgentChangeDetail,
  InstructionChangeDetail,
  ModelChangeDetail,
  SessionTypeChangeDetail,
  AgentOptionData,
  ModelOptionData,
} from '@shared/schemas';

@customElement('instruction-panel')
export class InstructionPanel extends LitElement {
  static override styles = [
    selectStyles,
    css`
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

      /* Select styles from shared selectStyles module */
      /* Component-specific overrides only */
      .agent-select-group {
        flex: 1;
        min-width: 0;
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
          opacity: 0.5;
        }
      }
    `,
  ];

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

  /** @deprecated Use workflowAgentOptions for Lit-native rendering */
  @property({ type: String }) workflowAgentOptionsHtml = '';

  /** @deprecated Use toolUseAgentOptions for Lit-native rendering */
  @property({ type: String }) toolUseAgentOptionsHtml = '';

  /** @deprecated Use modelOptions for Lit-native rendering */
  @property({ type: String }) modelOptionsHtml = '';

  /** Typed workflow agent options for Lit-native rendering */
  @property({ type: Array }) workflowAgentOptions: AgentOptionData[] = [];

  /** Typed tool-use agent options for Lit-native rendering */
  @property({ type: Array }) toolUseAgentOptions: AgentOptionData[] = [];

  /** Typed model options for Lit-native rendering */
  @property({ type: Array }) modelOptions: ModelOptionData[] = [];

  /** Whether recording is active */
  @property({ type: Boolean }) isRecording = false;

  /** Whether polishing is active */
  @property({ type: Boolean }) isPolishing = false;

  /** Whether debug mode is enabled */
  @property({ type: Boolean }) debugMode = false;

  @consume({ context: sessionContext, subscribe: true })
  private sessionData?: SessionContextValue;

  /** Reference to instruction textarea for paste handling */
  @query('#instruction')
  private instructionTextarea?: HTMLElement;

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

  /** Handle paste event on instruction textarea (Lit-native) */
  private handleInstructionPaste = async (event: Event): Promise<void> => {
    if (!(event instanceof ClipboardEvent)) return;
    if (!this.instructionTextarea) return;
    const handled = await handleImagePaste(event, this.instructionTextarea);
    if (handled) {
      // Get updated value from textarea after image paste
      const target = event.target as HTMLTextAreaElement;
      const updatedValue = target.value ?? '';
      this.dispatchEvent(
        this.createEvent<InstructionChangeDetail>('instruction-input', {
          value: updatedValue,
        }),
      );
      // Dispatch additional event so parent can save state
      this.dispatchEvent(
        new CustomEvent('instruction-paste', { bubbles: true, composed: true }),
      );
    }
  };

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

  private get resolvedSession(): SessionContextValue {
    return (
      this.sessionData ?? {
        sessionType: this.sessionType,
        instruction: this.instruction,
        placeholder: this.placeholder,
        workflowAgent: this.workflowAgent,
        toolUseAgent: this.toolUseAgent,
        model: this.model,
        workflowAgentOptionsHtml: this.workflowAgentOptionsHtml,
        toolUseAgentOptionsHtml: this.toolUseAgentOptionsHtml,
        modelOptionsHtml: this.modelOptionsHtml,
        workflowAgentOptions: this.workflowAgentOptions,
        toolUseAgentOptions: this.toolUseAgentOptions,
        modelOptions: this.modelOptions,
        isRecording: this.isRecording,
        isPolishing: this.isPolishing,
        debugMode: this.debugMode,
      }
    );
  }

  /**
   * Render workflow agent options - prefer typed data, fall back to HTML string.
   */
  private renderWorkflowAgentOptions(): TemplateResult {
    const session = this.resolvedSession;
    if (session.workflowAgentOptions.length > 0) {
      return renderAgentOptions(
        session.workflowAgentOptions,
        session.workflowAgent,
        'Select agent',
      );
    }
    // Fallback to HTML string (legacy)
    const htmlOptions = markOptionAsSelected(
      withPlaceholder(
        session.workflowAgentOptionsHtml,
        '<vscode-option value="">Select agent</vscode-option>',
      ),
      session.workflowAgent,
    );
    return html`${unsafeHTML(htmlOptions)}`;
  }

  /**
   * Render tool-use agent options - prefer typed data, fall back to HTML string.
   */
  private renderToolUseAgentOptions(): TemplateResult {
    const session = this.resolvedSession;
    if (session.toolUseAgentOptions.length > 0) {
      return renderAgentOptions(
        session.toolUseAgentOptions,
        session.toolUseAgent,
        'Select agent',
      );
    }
    // Fallback to HTML string (legacy)
    const htmlOptions = markOptionAsSelected(
      withPlaceholder(
        session.toolUseAgentOptionsHtml,
        '<vscode-option value="">Select agent</vscode-option>',
      ),
      session.toolUseAgent,
    );
    return html`${unsafeHTML(htmlOptions)}`;
  }

  /**
   * Render model options - prefer typed data, fall back to HTML string.
   */
  private renderModelOptionsTemplate(): TemplateResult {
    const session = this.resolvedSession;
    if (session.modelOptions.length > 0) {
      return renderModelOptions(
        session.modelOptions,
        session.model,
        'Select model',
      );
    }
    // Fallback to HTML string (legacy)
    const htmlOptions = markOptionAsSelected(
      withPlaceholder(
        session.modelOptionsHtml,
        '<vscode-option value="">Select model</vscode-option>',
      ),
      session.model,
    );
    return html`${unsafeHTML(htmlOptions)}`;
  }

  override render(): TemplateResult {
    const session = this.resolvedSession;
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
          <vscode-toolbar-container class="instruction-header-actions">
            <vscode-toolbar-button
              id="packButton"
              icon="archive"
              label="Pack output to History"
              title="Pack the output for this agent into the History folder"
              style=${styleMap({ display: session.debugMode ? '' : 'none' })}
              @click=${() => this.handleAction('pack')}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="cleanButton"
              icon="trash"
              label="Clean output"
              title="Clean the output for this agent"
              style=${styleMap({ display: session.debugMode ? '' : 'none' })}
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
              style=${styleMap({
                display: session.isPolishing ? 'block' : 'none',
                ...(session.isPolishing && { width: '16px', height: '16px' }),
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
          placeholder=${session.placeholder}
          .value=${session.instruction}
          @input=${(event: Event) => {
            const target = event.target as HTMLTextAreaElement;
            this.handleInstructionInput(target.value);
          }}
          @paste=${this.handleInstructionPaste}
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
                        session.sessionType !== SESSION_TYPES.WORKFLOW,
                      'agent-select--active':
                        session.sessionType === SESSION_TYPES.WORKFLOW,
                    })}
                    data-session-type="workflow"
                    aria-label="Workflow agent"
                    tabindex=${session.sessionType === SESSION_TYPES.WORKFLOW
                      ? 0
                      : -1}
                    aria-hidden=${session.sessionType === SESSION_TYPES.WORKFLOW
                      ? 'false'
                      : 'true'}
                    position="above"
                    .value=${session.workflowAgent}
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
                    ${this.renderWorkflowAgentOptions()}
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
                    position="above"
                    .value=${session.toolUseAgent}
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
                    ${this.renderToolUseAgentOptions()}
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
                .value=${session.model}
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
                ${this.renderModelOptionsTemplate()}
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
