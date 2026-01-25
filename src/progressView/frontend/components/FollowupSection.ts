// Third-party imports
import {
  LitElement,
  html,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

// Local imports - common helpers
import {
  applyAgentOptions,
  applyModelOptions,
  withPlaceholder,
  AGENT_PLACEHOLDER,
  MODEL_PLACEHOLDER,
} from '@common/modules/dropdownUtils.js';

// Local imports - shared utilities
import { getRadioChangeValue, setRadioGroupValue } from '@shared/utils/dom';

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

  @query(`#${ELEMENT_IDS.FOLLOWUP_AGENT}`)
  declare private agentSelect: (HTMLElement & { value?: string }) | null;

  @query(`#${ELEMENT_IDS.FOLLOWUP_MODEL}`)
  declare private modelSelect: (HTMLElement & { value?: string }) | null;

  @query(`#${ELEMENT_IDS.FOLLOWUP_INCLUDE_INSTRUCTION}`)
  declare private includeCheckbox: (HTMLElement & { checked?: boolean }) | null;

  @query(`#${ELEMENT_IDS.FOLLOWUP_ATTACH_OUTPUTS}`)
  declare private attachCheckbox: (HTMLElement & { checked?: boolean }) | null;

  @query(`#${ELEMENT_IDS.FOLLOWUP_INITIAL_QUESTION}`)
  declare private questionInput: (HTMLElement & { value?: string }) | null;

  @query('#followupModeGroup')
  declare private modeGroup: HTMLElement | null;

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
    const status = this.streamData?.status;
    const isTerminal = status === 'stopped' || status === 'ready';
    const visible =
      this.streamData?.agentCategory === 'workflow' &&
      isTerminal &&
      Boolean(this.streamData?.hasOutputFiles);

    return html`
      <vscode-collapsible
        id=${ELEMENT_IDS.FOLLOWUP_COLLAPSIBLE}
        class="followup-collapsible progress-collapsible"
        title="Followup"
        ?hidden=${!visible}
        aria-hidden=${visible ? 'false' : 'true'}
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
            <vscode-text-area
              id=${ELEMENT_IDS.FOLLOWUP_INITIAL_QUESTION}
              placeholder="What would you like to discuss about the results?"
              rows="2"
            ></vscode-text-area>
          </div>

          <div class="followup-options">
            <vscode-checkbox id=${ELEMENT_IDS.FOLLOWUP_INCLUDE_INSTRUCTION} checked
              >Include previous instruction</vscode-checkbox
            >
            <vscode-checkbox id=${ELEMENT_IDS.FOLLOWUP_ATTACH_OUTPUTS}
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
    const agent = this.mode === 'merge' ? 'merge' : this.agentSelect?.value;
    const model = this.modelSelect?.value;
    if (!agent || !model) return null;

    return {
      agent,
      model,
      includeInstruction: this.includeCheckbox?.checked ?? false,
      attachOutputs: this.attachCheckbox?.checked ?? false,
      initialQuestion: this.questionInput?.value?.trim() ?? '',
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
    if (this.modeGroup) {
      setRadioGroupValue(this.modeGroup, this.mode);
    }
  }

  private applyOptions(): void {
    if (!this.options) return;

    if (this.agentSelect) {
      const agentsHtml =
        this.mode === 'chat'
          ? this.options.toolUseAgentsHtml
          : this.options.workflowAgentsHtml;
      applyAgentOptions(
        this.agentSelect,
        withPlaceholder(agentsHtml, AGENT_PLACEHOLDER),
      );
    }

    if (this.modelSelect && this.options.modelOptionsHtml) {
      const preferredModel =
        this.mode === 'merge'
          ? this.options.defaultMergeModel
          : this.streamModel || this.modelSelect.value;
      applyModelOptions(
        this.modelSelect,
        withPlaceholder(this.options.modelOptionsHtml, MODEL_PLACEHOLDER),
        { preserveValue: preferredModel },
      );
    }
  }
}
