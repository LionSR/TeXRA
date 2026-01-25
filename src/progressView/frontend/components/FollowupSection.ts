// Third-party imports
import {
  LitElement,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';

// Local imports - common helpers
import {
  applyAgentOptions,
  applyModelOptions,
  withPlaceholder,
  AGENT_PLACEHOLDER,
  MODEL_PLACEHOLDER,
} from '@common/modules/dropdownUtils.js';

// Local imports - shared schemas
import type { SetFollowupOptionsMessage } from '@shared/schemas';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';
import { ProgressEvents } from '../events';
import type { FollowupMode } from '../store';
import { getRadioValue, type VSCodeValueElement } from '../utils';

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
  // Declarative visibility props - parent computes, component renders
  @property({ type: String }) agentCategory: string = '';
  @property({ type: String }) status: string = '';
  @property({ type: Boolean }) hasOutputFiles: boolean = false;

  // Configuration props
  @property({ type: Object }) options: FollowupOptions | null = null;
  @property({ type: String }) mode: FollowupMode = 'chat';
  @property({ type: String }) streamModel: string | null = null;

  // Reactive form state (Lit-native pattern)
  @state() private includeInstruction = true;
  @state() private attachOutputs = false;
  @state() private initialQuestion = '';

  // Agent/model selects still use @query due to dropdownUtils HTML injection
  @query(`#${ELEMENT_IDS.FOLLOWUP_AGENT}`)
  declare private agentSelect: VSCodeValueElement | null;

  @query(`#${ELEMENT_IDS.FOLLOWUP_MODEL}`)
  declare private modelSelect: VSCodeValueElement | null;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  // firstUpdated removed - Lit's .value binding handles initial radio state

  updated(changedProps: PropertyValues): void {
    // Radio group sync handled by .value binding, only need to apply options
    if (changedProps.has('mode') || changedProps.has('options')) {
      this.applyOptions();
    }
  }

  render(): TemplateResult | typeof nothing {
    // Visibility computed from declarative props
    const isTerminal = this.status === 'stopped' || this.status === 'ready';
    const visible =
      this.agentCategory === 'workflow' && isTerminal && this.hasOutputFiles;

    if (!visible) {
      return nothing;
    }

    return html`
      <vscode-collapsible
        id=${ELEMENT_IDS.FOLLOWUP_COLLAPSIBLE}
        class="followup-collapsible progress-collapsible"
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
              <vscode-radio id=${ELEMENT_IDS.FOLLOWUP_MODE_CHAT} value="chat">
                Chat
              </vscode-radio>
              <vscode-radio
                id=${ELEMENT_IDS.FOLLOWUP_MODE_WORKFLOW}
                value="workflow"
              >
                Workflow
              </vscode-radio>
              <vscode-radio id=${ELEMENT_IDS.FOLLOWUP_MODE_MERGE} value="merge">
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
              ></vscode-single-select>
            </div>
            <div class="followup-select-group">
              <i class="codicon codicon-robot"></i>
              <vscode-single-select
                id=${ELEMENT_IDS.FOLLOWUP_MODEL}
                class="followup-model-select"
                position="above"
              ></vscode-single-select>
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

          <div class="followup-options">
            <vscode-checkbox
              id=${ELEMENT_IDS.FOLLOWUP_INCLUDE_INSTRUCTION}
              ?checked=${this.includeInstruction}
              @change=${this.handleIncludeChange}
              >Include previous instruction</vscode-checkbox
            >
            <vscode-checkbox
              id=${ELEMENT_IDS.FOLLOWUP_ATTACH_OUTPUTS}
              ?checked=${this.attachOutputs}
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
    // Radio group sync handled automatically by Lit's .value binding
  }

  private getFormData(): FollowupFormData | null {
    // Agent/model still from DOM (dropdownUtils), rest from reactive state
    const agent =
      this.mode === 'merge' ? MERGE_AGENT_NAME : this.agentSelect?.value;
    const model = this.modelSelect?.value;
    if (!agent || !model) return null;

    return {
      agent,
      model,
      includeInstruction: this.includeInstruction,
      attachOutputs: this.attachOutputs,
      initialQuestion: this.initialQuestion.trim(),
    };
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

  // Form input handlers (Lit-native pattern)
  private handleQuestionInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement | null;
    this.initialQuestion = target?.value ?? '';
  }

  private handleIncludeChange(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.includeInstruction = target?.checked ?? false;
  }

  private handleAttachChange(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.attachOutputs = target?.checked ?? false;
  }

  private applyOptions(): void {
    if (!this.options) return;

    if (this.agentSelect) {
      const agentsHtml =
        this.mode === 'chat'
          ? (this.options.toolUseAgentsHtml ?? '')
          : (this.options.workflowAgentsHtml ?? '');
      applyAgentOptions(
        this.agentSelect,
        withPlaceholder(agentsHtml, AGENT_PLACEHOLDER),
      );
    }

    const modelHtml = this.options.modelOptionsHtml ?? '';
    if (this.modelSelect && modelHtml) {
      const preferredModel =
        this.mode === 'merge'
          ? this.options.defaultMergeModel
          : this.streamModel || this.modelSelect.value;
      applyModelOptions(
        this.modelSelect,
        withPlaceholder(modelHtml, MODEL_PLACEHOLDER),
        { preserveValue: preferredModel },
      );
    }
  }
}
