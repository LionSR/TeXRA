// Third-party imports
import {
  LitElement,
  html,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - common helpers
import {
  applyAgentOptions,
  applyModelOptions,
  withPlaceholder,
  AGENT_PLACEHOLDER,
  MODEL_PLACEHOLDER,
} from '@common/modules/dropdownUtils.js';
import {
  getRadioChangeValue,
  setRadioGroupValue,
} from '@common/modules/domUtils.js';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';
import { ProgressEvents } from '../events';
import type { FollowupMode } from '../store';

export interface FollowupStreamData {
  agentCategory: string;
  status?: string;
  hasOutputFiles?: boolean;
  agentName?: string;
  instructionPreview?: string | null;
  fileCount?: number;
}

export interface FollowupFormData {
  agent: string;
  model: string;
  includeInstruction: boolean;
  attachOutputs: boolean;
  initialQuestion: string;
}

export interface FollowupOptions {
  workflowAgentsHtml: string;
  toolUseAgentsHtml: string;
  modelOptionsHtml: string;
  defaultMergeModel?: string;
}

@customElement('followup-section')
export class FollowupSection extends LitElement {
  @property({ type: Object }) streamData: FollowupStreamData | null = null;
  @property({ type: Object }) options: FollowupOptions | null = null;
  @property({ type: String }) mode: FollowupMode = 'chat';
  @property({ type: String }) streamModel: string | null = null;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  firstUpdated(): void {
    this.syncRadioGroup();
  }

  updated(changedProps: PropertyValues): void {
    if (changedProps.has('mode')) {
      this.syncRadioGroup();
    }
    this.applyOptions();
  }

  render(): TemplateResult {
    const visible =
      this.streamData?.agentCategory === 'workflow' &&
      this.streamData?.status === 'stopped' &&
      Boolean(this.streamData?.hasOutputFiles);

    return html`
      <vscode-collapsible
        id=${ELEMENT_IDS.FOLLOWUP_COLLAPSIBLE}
        class="followup-collapsible progress-collapsible"
        title="Follow-up"
        ?hidden=${!visible}
        aria-hidden=${visible ? 'false' : 'true'}
        @vsc-collapsible-toggle=${this.handleToggle}
      >
        <div class="followup-section" data-mode=${this.mode}>
          <div class="followup-mode-toggle">
            <vscode-radio-group
              id="followupModeGroup"
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
              <i class="codicon codicon-tools"></i>
              <vscode-single-select
                id=${ELEMENT_IDS.FOLLOWUP_AGENT}
                class="followup-agent-select"
              ></vscode-single-select>
            </div>
            <div class="followup-select-group">
              <i class="codicon codicon-chip"></i>
              <vscode-single-select
                id=${ELEMENT_IDS.FOLLOWUP_MODEL}
                class="followup-model-select"
              ></vscode-single-select>
            </div>
          </div>

          <div class="followup-initial-question">
            <label for=${ELEMENT_IDS.FOLLOWUP_INITIAL_QUESTION}>
              Initial question
            </label>
            <vscode-text-area
              id=${ELEMENT_IDS.FOLLOWUP_INITIAL_QUESTION}
              placeholder="Ask the agent to continue from this output..."
            ></vscode-text-area>
          </div>

          <div class="followup-options">
            <vscode-checkbox id=${ELEMENT_IDS.FOLLOWUP_INCLUDE_INSTRUCTION}
              >Include original instruction</vscode-checkbox
            >
            <vscode-checkbox id=${ELEMENT_IDS.FOLLOWUP_ATTACH_OUTPUTS}
              >Attach agent outputs</vscode-checkbox
            >
          </div>

          <div class="followup-actions">
            <vscode-button
              id=${ELEMENT_IDS.FOLLOWUP_SETUP_BTN}
              @click=${this.emitSetup}
            >
              Setup
            </vscode-button>
            <vscode-button
              id=${ELEMENT_IDS.FOLLOWUP_RUN_BTN}
              appearance="primary"
              @click=${this.emitRun}
            >
              Run
            </vscode-button>
          </div>
        </div>
      </vscode-collapsible>
    `;
  }

  private handleModeChange(event: Event): void {
    const group = event.currentTarget as HTMLElement | null;
    const nextMode = getRadioChangeValue(event, group) as FollowupMode;
    if (!nextMode) return;

    this.dispatchEvent(ProgressEvents.followupModeChange({ mode: nextMode }));
  }

  private handleToggle(event: CustomEvent): void {
    if (!event.detail?.open) return;
    this.dispatchEvent(ProgressEvents.followupRequestOptions());
    this.syncRadioGroup();
  }

  private getFormData(): FollowupFormData | null {
    const agentSelect = this.querySelector(`#${ELEMENT_IDS.FOLLOWUP_AGENT}`) as
      | (HTMLElement & { value?: string })
      | null;
    const modelSelect = this.querySelector(`#${ELEMENT_IDS.FOLLOWUP_MODEL}`) as
      | (HTMLElement & { value?: string })
      | null;
    const includeCheckbox = this.querySelector(
      `#${ELEMENT_IDS.FOLLOWUP_INCLUDE_INSTRUCTION}`,
    ) as (HTMLElement & { checked?: boolean }) | null;
    const attachCheckbox = this.querySelector(
      `#${ELEMENT_IDS.FOLLOWUP_ATTACH_OUTPUTS}`,
    ) as (HTMLElement & { checked?: boolean }) | null;
    const questionInput = this.querySelector(
      `#${ELEMENT_IDS.FOLLOWUP_INITIAL_QUESTION}`,
    ) as (HTMLElement & { value?: string }) | null;

    const agent = this.mode === 'merge' ? 'merge' : agentSelect?.value;
    const model = modelSelect?.value;
    if (!agent || !model) return null;

    return {
      agent,
      model,
      includeInstruction: includeCheckbox?.checked ?? false,
      attachOutputs: attachCheckbox?.checked ?? false,
      initialQuestion: questionInput?.value?.trim() ?? '',
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

  private syncRadioGroup(): void {
    const group = this.querySelector(
      '#followupModeGroup',
    ) as HTMLElement | null;
    if (group) {
      setRadioGroupValue(group, this.mode);
    }
  }

  private applyOptions(): void {
    if (!this.options) return;

    const agentSelect = this.querySelector(`#${ELEMENT_IDS.FOLLOWUP_AGENT}`) as
      | (HTMLElement & { value?: string })
      | null;
    const modelSelect = this.querySelector(`#${ELEMENT_IDS.FOLLOWUP_MODEL}`) as
      | (HTMLElement & { value?: string })
      | null;

    if (agentSelect) {
      const agentsHtml =
        this.mode === 'chat'
          ? this.options.toolUseAgentsHtml
          : this.options.workflowAgentsHtml;
      applyAgentOptions(
        agentSelect,
        withPlaceholder(agentsHtml, AGENT_PLACEHOLDER),
      );
    }

    if (modelSelect && this.options.modelOptionsHtml) {
      const preferredModel =
        this.mode === 'merge'
          ? this.options.defaultMergeModel
          : this.streamModel || modelSelect.value;
      applyModelOptions(
        modelSelect,
        withPlaceholder(this.options.modelOptionsHtml, MODEL_PLACEHOLDER),
        { preserveValue: preferredModel },
      );
    }
  }
}
