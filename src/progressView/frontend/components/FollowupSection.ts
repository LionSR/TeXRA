// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports - dropdown helpers
import {
  AGENT_PLACEHOLDER,
  MODEL_PLACEHOLDER,
  applyAgentOptions,
  applyModelOptions,
  withPlaceholder,
} from '@common/modules/dropdownUtils.js';

export type FollowupMode = 'chat' | 'workflow' | 'merge';

export interface FollowupOptions {
  workflowAgentsHtml?: string;
  toolUseAgentsHtml?: string;
  modelOptionsHtml?: string;
  defaultMergeModel?: string;
}

@customElement('followup-section')
export class FollowupSection extends LitElement {
  @property({ type: Object }) options: FollowupOptions | null = null;
  @property({ type: String }) mode: FollowupMode = 'chat';
  @property({ type: String }) agent = '';
  @property({ type: String }) model = '';
  @property({ type: String }) initialQuestion = '';
  @property({ type: Boolean }) includeInstruction = false;
  @property({ type: Boolean }) attachOutputs = false;
  @property({ type: Boolean }) visible = false;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  protected override updated(): void {
    this.applyOptions();
  }

  private applyOptions() {
    const agentSelect = this.querySelector(
      '#followupAgent',
    ) as HTMLElement | null;
    const modelSelect = this.querySelector(
      '#followupModel',
    ) as HTMLElement | null;

    if (agentSelect && this.options) {
      const agentOptions =
        this.mode === 'chat'
          ? this.options.toolUseAgentsHtml
          : this.options.workflowAgentsHtml;
      if (agentOptions) {
        applyAgentOptions(
          agentSelect,
          withPlaceholder(agentOptions, AGENT_PLACEHOLDER),
          {
            preserveValue: this.agent,
          },
        );
      }
    }

    if (modelSelect && this.options?.modelOptionsHtml) {
      const preferredModel =
        this.mode === 'merge'
          ? (this.options.defaultMergeModel ?? this.model)
          : this.model;
      applyModelOptions(
        modelSelect,
        withPlaceholder(this.options.modelOptionsHtml, MODEL_PLACEHOLDER),
        {
          preserveValue: preferredModel,
        },
      );
    }
  }

  private updateState(
    patch: Partial<{
      mode: FollowupMode;
      agent: string;
      model: string;
      initialQuestion: string;
      includeInstruction: boolean;
      attachOutputs: boolean;
    }>,
  ) {
    this.dispatchEvent(
      new CustomEvent('followup-state-change', {
        detail: patch,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleModeChange(event: Event) {
    const target = event.target as HTMLElement | null;
    const radio = target?.closest('vscode-radio');
    const value = (radio?.getAttribute('value') ||
      radio?.value) as FollowupMode;
    if (!value) return;
    this.updateState({ mode: value });
  }

  private handleAgentChange(event: Event) {
    const target = event.target as HTMLSelectElement | null;
    this.updateState({ agent: target?.value ?? '' });
  }

  private handleModelChange(event: Event) {
    const target = event.target as HTMLSelectElement | null;
    this.updateState({ model: target?.value ?? '' });
  }

  private handleInitialQuestion(event: Event) {
    const target = event.target as HTMLTextAreaElement | null;
    this.updateState({ initialQuestion: target?.value ?? '' });
  }

  private handleCheckbox(
    event: Event,
    field: 'includeInstruction' | 'attachOutputs',
  ) {
    const target = event.target as HTMLInputElement | null;
    this.updateState({ [field]: Boolean(target?.checked) });
  }

  private handleSetup() {
    this.dispatchEvent(
      new CustomEvent('followup-setup', { bubbles: true, composed: true }),
    );
  }

  private handleRun() {
    this.dispatchEvent(
      new CustomEvent('followup-run', { bubbles: true, composed: true }),
    );
  }

  private handleToggle(event: Event) {
    const target = event.target as HTMLElement | null;
    const isOpen = Boolean((target as HTMLDetailsElement | undefined)?.open);
    if (!isOpen) return;
    this.dispatchEvent(
      new CustomEvent('followup-opened', { bubbles: true, composed: true }),
    );
  }

  override render() {
    if (!this.visible) return null;

    const sectionClasses = classMap({
      'followup-section': true,
    });

    return html`
      <vscode-collapsible
        id="followupCollapsible"
        class="followup-collapsible"
        title="Follow-up"
        @toggle=${this.handleToggle}
      >
        <div class=${sectionClasses} data-mode=${this.mode}>
          <div class="followup-mode-toggle">
            <vscode-radio-group
              id="followupModeGroup"
              @change=${this.handleModeChange}
            >
              <vscode-radio value="chat" ?checked=${this.mode === 'chat'}>
                Chat
              </vscode-radio>
              <vscode-radio
                value="workflow"
                ?checked=${this.mode === 'workflow'}
              >
                Workflow
              </vscode-radio>
              <vscode-radio value="merge" ?checked=${this.mode === 'merge'}>
                Merge
              </vscode-radio>
            </vscode-radio-group>
          </div>

          <div class="followup-selects">
            <div class="followup-select-group">
              <i class="codicon codicon-robot"></i>
              <vscode-dropdown
                id="followupAgent"
                class="followup-agent-select"
                @change=${this.handleAgentChange}
              ></vscode-dropdown>
            </div>
            <div class="followup-select-group">
              <i class="codicon codicon-chip"></i>
              <vscode-dropdown
                id="followupModel"
                class="followup-model-select"
                @change=${this.handleModelChange}
              ></vscode-dropdown>
            </div>
          </div>

          <div class="followup-initial-question">
            <vscode-text-area
              id="followupInitialQuestion"
              placeholder="Add an initial question for the follow-up..."
              .value=${this.initialQuestion}
              @input=${this.handleInitialQuestion}
            ></vscode-text-area>
          </div>

          <div class="followup-options">
            <vscode-checkbox
              id="followupIncludeInstruction"
              ?checked=${this.includeInstruction}
              @change=${(event: Event) =>
                this.handleCheckbox(event, 'includeInstruction')}
            >
              Include instruction
            </vscode-checkbox>
            <vscode-checkbox
              id="followupAttachOutputs"
              ?checked=${this.attachOutputs}
              @change=${(event: Event) =>
                this.handleCheckbox(event, 'attachOutputs')}
            >
              Attach outputs
            </vscode-checkbox>
          </div>

          <div class="followup-actions">
            <vscode-button id="followupSetupBtn" @click=${this.handleSetup}>
              Setup
            </vscode-button>
            <vscode-button id="followupRunBtn" @click=${this.handleRun}>
              Run
            </vscode-button>
          </div>
        </div>
      </vscode-collapsible>
    `;
  }
}
