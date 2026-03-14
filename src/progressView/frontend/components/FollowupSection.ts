// Third-party imports
import {
  LitElement,
  html,
  css,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';

// Local imports - shared
import { designTokens } from '@shared/styles';
import {
  STREAM_STATUS,
  type SetFollowupOptionsMessage,
  type AgentOptionData,
  type ModelOptionData,
} from '@shared/schemas';
import { commonViewStyles } from '@shared/styles/commonViewStyles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';
import {
  renderAgentOptions,
  renderModelOptions,
} from '@shared/utils/selectTemplates';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';
import { ProgressEvents } from '../events';
import { getRadioValue } from '../utils';
import type { FollowupMode } from '../store';

/** Agent name used for merge mode (fixed, not user-selectable) */
const MERGE_AGENT_NAME = 'merge';

/**
 * Form data collected from the followup section inputs.
 * Component-local type for getFormData() return value.
 */
export interface FollowupFormData {
  agent: string;
  model: string;
  includeInstruction: boolean;
  attachOutputs: boolean;
  initialQuestion: string;
}

/**
 * Followup options received from backend.
 * Derived from SetFollowupOptionsMessage schema (minus command field).
 */
export type FollowupOptions = Omit<SetFollowupOptionsMessage, 'command'>;

@customElement('followup-section')
export class FollowupSection extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconIconClasses,
    css`
      :host {
        display: block;
        margin-top: var(--spacing-medium);
      }

      :host([hidden]) {
        display: none;
      }

      .followup-section {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-medium);
        padding: var(--spacing-small) 0;
      }

      .followup-mode-toggle {
        display: flex;
        align-items: center;
      }

      .followup-mode-toggle vscode-radio-group {
        display: flex;
        gap: var(--spacing-large);
      }

      .followup-selects {
        display: flex;
        gap: var(--spacing-medium);
        flex-wrap: wrap;
      }

      .followup-select-group {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        flex: 1;
        min-width: 120px;
        position: relative;
      }

      .followup-select-group .codicon {
        color: var(--vscode-descriptionForeground);
        flex-shrink: 0;
      }

      .followup-agent-select,
      .followup-model-select {
        flex: 1;
        min-width: 0;
      }

      #followupAgent::part(listbox),
      #followupModel::part(listbox) {
        bottom: 100%;
        top: auto;
      }

      .followup-section[data-mode='merge']
        .followup-select-group:has(.followup-agent-select) {
        display: none;
      }

      .followup-initial-question {
        display: none;
        flex-direction: column;
      }

      .followup-section[data-mode='chat'] .followup-initial-question {
        display: flex;
      }

      .followup-initial-question vscode-textarea {
        width: 100%;
      }

      .followup-options {
        display: flex;
        align-items: center;
        gap: var(--spacing-medium);
      }

      .followup-section[data-mode='chat'] .followup-options,
      .followup-section[data-mode='merge'] .followup-options {
        display: none;
      }

      .followup-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--spacing-small);
        margin-top: var(--spacing-small);
      }

      .followup-actions vscode-button {
        min-width: 80px;
      }

      .followup-section[data-mode='merge'] #followupSetupBtn {
        display: none;
      }
    `,
  ];

  @property({ attribute: false }) agentCategory = '';
  @property({ attribute: false }) status = '';
  @property({ attribute: false }) hasOutputFiles = false;

  // Configuration props
  @property({ attribute: false }) options: FollowupOptions | null = null;
  @property({ attribute: false }) mode: FollowupMode = 'chat';
  @property({ attribute: false }) streamModel: string | null = null;

  @state() private includeInstruction = true;
  @state() private attachOutputs = false;
  @state() private initialQuestion = '';
  @state() private selectedAgent = '';
  @state() private selectedModel = '';

  @state() private workflowAgentOptions: AgentOptionData[] = [];
  @state() private toolUseAgentOptions: AgentOptionData[] = [];
  @state() private modelOptions: ModelOptionData[] = [];

  updated(changedProps: PropertyValues): void {
    if (changedProps.has('mode') || changedProps.has('options')) {
      this.applyOptions();
    }
  }

  override render(): TemplateResult | typeof nothing {
    // READY streams have their status deleted from statusMemory, so
    // this.status will be undefined for ready streams. Treat undefined as ready.
    const isTerminal =
      this.status === STREAM_STATUS.STOPPED ||
      this.status === STREAM_STATUS.READY ||
      this.status === undefined;
    const visible =
      this.agentCategory === 'workflow' && isTerminal && this.hasOutputFiles;

    if (!visible) {
      return nothing;
    }

    return html`
      <vscode-collapsible
        id=${ELEMENT_IDS.FOLLOWUP_COLLAPSIBLE}
        class="panel-collapsible"
        title="Followup"
        @vsc-collapsible-toggle=${this.handleToggle}
      >
        <div class="followup-section" data-mode=${this.mode}>
          <div class="followup-mode-toggle">
            <vscode-radio-group
              id="followupModeGroup"
              orientation="horizontal"
              .value=${this.mode}
              @change=${this.handleModeChange}
            >
              <vscode-radio
                id=${ELEMENT_IDS.FOLLOWUP_MODE_CHAT}
                value="chat"
                ?checked=${this.mode === 'chat'}
              >
                Chat
              </vscode-radio>
              <vscode-radio
                id=${ELEMENT_IDS.FOLLOWUP_MODE_WORKFLOW}
                value="workflow"
                ?checked=${this.mode === 'workflow'}
              >
                Workflow
              </vscode-radio>
              <vscode-radio
                id=${ELEMENT_IDS.FOLLOWUP_MODE_MERGE}
                value="merge"
                ?checked=${this.mode === 'merge'}
              >
                Merge
              </vscode-radio>
            </vscode-radio-group>
          </div>

          <div class="followup-selects">
            <div class="followup-select-group">
              <i class="codicon codicon-sparkle"></i>
              <vscode-single-select
                id=${ELEMENT_IDS.FOLLOWUP_AGENT}
                class="followup-agent-select"
                position="above"
                tabindex=${this.mode === 'merge' ? -1 : 0}
                aria-hidden=${this.mode === 'merge' ? 'true' : 'false'}
                .value=${this.selectedAgent}
                @change=${this.handleAgentChange}
              >
                ${this.renderAgentSelect()}
              </vscode-single-select>
            </div>
            <div class="followup-select-group">
              <i class="codicon codicon-robot"></i>
              <vscode-single-select
                id=${ELEMENT_IDS.FOLLOWUP_MODEL}
                class="followup-model-select"
                position="above"
                .value=${this.selectedModel}
                @change=${this.handleModelChange}
              >
                ${this.renderModelSelect()}
              </vscode-single-select>
            </div>
          </div>

          <div class="followup-initial-question">
            <vscode-textarea
              id=${ELEMENT_IDS.FOLLOWUP_INITIAL_QUESTION}
              placeholder="What would you like to discuss about the results?"
              rows="2"
              .value=${live(this.initialQuestion)}
              @input=${this.handleQuestionInput}
            ></vscode-textarea>
          </div>

          <div
            class="followup-options"
            aria-hidden=${this.mode !== 'workflow' ? 'true' : 'false'}
          >
            <vscode-checkbox
              id=${ELEMENT_IDS.FOLLOWUP_INCLUDE_INSTRUCTION}
              ?checked=${this.includeInstruction}
              tabindex=${this.mode === 'workflow' ? 0 : -1}
              @change=${this.handleIncludeChange}
              >Include previous instruction</vscode-checkbox
            >
            <vscode-checkbox
              id=${ELEMENT_IDS.FOLLOWUP_ATTACH_OUTPUTS}
              ?checked=${this.attachOutputs}
              tabindex=${this.mode === 'workflow' ? 0 : -1}
              @change=${this.handleAttachChange}
              >Modify originals (attach outputs as reference)</vscode-checkbox
            >
          </div>

          <div class="followup-actions">
            <vscode-button
              id=${ELEMENT_IDS.FOLLOWUP_SETUP_BTN}
              appearance="secondary"
              @click=${this.emitSetup}
            >
              <span slot="start" class="codicon codicon-reply"></span>
              Setup
            </vscode-button>
            <vscode-button
              id=${ELEMENT_IDS.FOLLOWUP_RUN_BTN}
              appearance="primary"
              @click=${this.emitRun}
            >
              <span slot="start" class="codicon codicon-play"></span>
              Run
            </vscode-button>
          </div>
        </div>
      </vscode-collapsible>
    `;
  }

  private handleModeChange(event: Event): void {
    const nextMode = getRadioValue<FollowupMode>(event);
    if (!nextMode) return;
    this.dispatchEvent(ProgressEvents.followupModeChange({ mode: nextMode }));
  }

  private handleToggle(event: CustomEvent): void {
    if (!event.detail?.open) return;
    this.dispatchEvent(ProgressEvents.followupRequestOptions());
  }

  private getFormData(): FollowupFormData | null {
    const agent = this.mode === 'merge' ? MERGE_AGENT_NAME : this.selectedAgent;
    const model = this.selectedModel;
    if (!agent || !model) return null;

    return {
      agent,
      model,
      includeInstruction: this.includeInstruction,
      attachOutputs: this.attachOutputs,
      initialQuestion: this.initialQuestion.trim(),
    };
  }

  private handleAgentChange(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement | null;
    this.selectedAgent = target?.value ?? '';
  }

  private handleModelChange(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement | null;
    this.selectedModel = target?.value ?? '';
  }

  private renderAgentSelect(): TemplateResult {
    const agentOptions =
      this.mode === 'chat'
        ? this.toolUseAgentOptions
        : this.workflowAgentOptions;
    return renderAgentOptions(agentOptions, this.selectedAgent);
  }

  private renderModelSelect(): TemplateResult {
    return renderModelOptions(this.modelOptions, this.selectedModel);
  }

  private emitSetup(): void {
    const formData = this.getFormData();
    if (!formData) return;
    this.dispatchEvent(
      ProgressEvents.followupSetup({ mode: this.mode, ...formData }),
    );
  }

  private emitRun(): void {
    const formData = this.getFormData();
    if (!formData) return;
    this.dispatchEvent(
      ProgressEvents.followupRun({ mode: this.mode, ...formData }),
    );
  }

  private handleQuestionInput(event: Event): void {
    const target = event.currentTarget as HTMLTextAreaElement | null;
    this.initialQuestion = target?.value ?? '';
  }

  private handleIncludeChange(event: Event): void {
    const target = event.currentTarget as HTMLInputElement | null;
    this.includeInstruction = target?.checked ?? false;
  }

  private handleAttachChange(event: Event): void {
    const target = event.currentTarget as HTMLInputElement | null;
    this.attachOutputs = target?.checked ?? false;
  }

  private applyOptions(): void {
    if (!this.options) return;

    if (this.options.workflowAgentsData) {
      this.workflowAgentOptions = this.options.workflowAgentsData;
    }
    if (this.options.toolUseAgentsData) {
      this.toolUseAgentOptions = this.options.toolUseAgentsData;
    }
    if (this.options.modelOptionsData) {
      this.modelOptions = this.options.modelOptionsData;
    }

    // Set default model based on mode
    const preferredModel =
      this.mode === 'merge'
        ? this.options.defaultMergeModel
        : this.streamModel || this.selectedModel;
    const modelIsValid =
      preferredModel &&
      this.modelOptions.some((m) => m.value === preferredModel);
    if (modelIsValid) {
      this.selectedModel = preferredModel;
    } else if (this.modelOptions.length > 0) {
      // Reset to first available model if current selection is invalid
      this.selectedModel = this.modelOptions[0].value;
    } else {
      this.selectedModel = '';
    }

    // Set or reset agent based on current mode's options
    const agentOptions =
      this.mode === 'chat'
        ? this.toolUseAgentOptions
        : this.workflowAgentOptions;
    const agentIsValid =
      this.selectedAgent &&
      agentOptions.some((a) => a.value === this.selectedAgent);
    if (!agentIsValid) {
      // Reset to first available agent if current selection is invalid for this mode
      this.selectedAgent = agentOptions.length > 0 ? agentOptions[0].value : '';
    }
  }
}
