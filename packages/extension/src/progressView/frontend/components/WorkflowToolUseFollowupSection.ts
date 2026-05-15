import {
  LitElement,
  css,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';

import { STREAM_STATUS, type StreamStatus } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import { selectStyles } from '@shared/styles/selectStyles';
import {
  renderAgentOptions,
  renderModelOptions,
} from '@shared/utils/selectTemplates';

import { ProgressEvents } from '../events';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';
import type { FollowupOptionsState } from '../store';

@customElement('workflow-tool-use-followup-section')
export class WorkflowToolUseFollowupSection extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    selectStyles,
    css`
      :host {
        display: block;
      }

      .followup__body {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-2xs);
      }

      .followup__description {
        line-height: 1.4;
      }

      .followup__controls {
        display: grid;
        grid-template-columns: minmax(160px, 1fr) minmax(160px, 1fr);
        gap: var(--wa-space-2xs);
      }

      .followup__field {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-3xs);
        min-width: 0;
      }

      .followup__label {
        font-size: var(--font-size-small);
        color: var(--color-text-secondary);
      }

      wa-textarea {
        width: 100%;
      }

      .followup__actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--wa-space-2xs);
      }

      @media (max-width: 600px) {
        .followup__controls {
          grid-template-columns: 1fr;
        }

        .followup__actions {
          flex-wrap: wrap;
        }
      }
    `,
  ];

  @property({ attribute: false }) status: StreamStatus | null = null;
  @property({ type: Boolean }) hasOutputFiles = false;
  @property({ attribute: false }) options: FollowupOptionsState | null = null;
  @property({ attribute: false }) streamModel: string | null = null;

  @state() private selectedAgent = '';
  @state() private selectedModel = '';
  @state() private initialQuestion = '';

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (
      changedProperties.has('options') ||
      changedProperties.has('streamModel')
    ) {
      this.syncSelections();
    }
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.shouldRender()) return nothing;

    const agents = this.options?.toolUseAgentsData ?? [];
    const models = this.options?.modelOptionsData ?? [];
    const ready = agents.length > 0 && models.some((model) => !model.disabled);

    return html`
      <wa-details
        class="panel-collapsible"
        summary="Tool-use follow-up"
        @wa-show=${this.handleShow}
        role="region"
        aria-label="Workflow tool-use follow-up"
      >
        <div class="followup__body">
          <div class="followup__description">
            Start an interactive tool-use chat from this workflow result. The
            new chat gets the workflow output locations and your note as
            context.
          </div>
          <div class="followup__controls">
            <label class="followup__field">
              <span class="followup__label">Agent</span>
              <wa-select
                placement="top"
                aria-label="Follow-up tool-use agent"
                .value=${this.selectedAgent}
                ?disabled=${agents.length === 0}
                @change=${this.handleAgentChange}
              >
                ${renderAgentOptions(agents, this.selectedAgent)}
              </wa-select>
            </label>
            <label class="followup__field">
              <span class="followup__label">Model</span>
              <wa-select
                placement="top"
                aria-label="Follow-up model"
                .value=${this.selectedModel}
                ?disabled=${models.length === 0}
                @change=${this.handleModelChange}
              >
                ${renderModelOptions(models, this.selectedModel)}
              </wa-select>
            </label>
          </div>
          <wa-textarea
            aria-label="Follow-up note"
            placeholder="Ask what the tool-use agent should do with these results."
            rows="3"
            resize="vertical"
            .value=${this.initialQuestion}
            @input=${this.handleQuestionInput}
          ></wa-textarea>
          <div class="followup__actions">
            <wa-button
              appearance="plain"
              size="small"
              ?disabled=${!ready}
              @click=${this.setupFollowup}
            >
              <wa-icon
                slot="start"
                library="texra"
                name="reply"
                aria-hidden="true"
              ></wa-icon>
              Setup
            </wa-button>
            <wa-button
              appearance="filled"
              variant="brand"
              size="small"
              ?disabled=${!ready}
              @click=${this.runFollowup}
            >
              <wa-icon
                slot="start"
                library="texra"
                name="play"
                aria-hidden="true"
              ></wa-icon>
              Run
            </wa-button>
          </div>
        </div>
      </wa-details>
    `;
  }

  private shouldRender(): boolean {
    return (
      this.hasOutputFiles &&
      (this.status == null ||
        this.status === STREAM_STATUS.READY ||
        this.status === STREAM_STATUS.ERROR ||
        this.status === STREAM_STATUS.STOPPED)
    );
  }

  private syncSelections(): void {
    const agents = this.options?.toolUseAgentsData ?? [];
    const models = this.options?.modelOptionsData ?? [];
    if (!agents.some((agent) => agent.value === this.selectedAgent)) {
      this.selectedAgent = agents[0]?.value ?? '';
    }

    const selectedModel = models.find(
      (model) => model.value === this.selectedModel && !model.disabled,
    );
    if (!selectedModel) {
      const streamModel = models.find(
        (model) => model.value === this.streamModel && !model.disabled,
      );
      this.selectedModel =
        streamModel?.value ??
        models.find((model) => !model.disabled)?.value ??
        '';
    }
  }

  private handleShow = (event: Event): void => {
    // wa-show bubbles from nested wa-select; only react to our own.
    if (event.target !== event.currentTarget) return;
    this.dispatchEvent(ProgressEvents.followupRequestOptions());
  };

  private handleAgentChange = (event: Event): void => {
    const select = event.currentTarget as WaSelect | null;
    const value = typeof select?.value === 'string' ? select.value : '';
    this.selectedAgent = value;
  };

  private handleModelChange = (event: Event): void => {
    const select = event.currentTarget as WaSelect | null;
    const value = typeof select?.value === 'string' ? select.value : '';
    this.selectedModel = value;
  };

  private handleQuestionInput = (event: Event): void => {
    this.initialQuestion = (event.currentTarget as HTMLInputElement).value;
  };

  private setupFollowup = (): void => {
    this.dispatchEvent(ProgressEvents.followupSetup(this.getFormData()));
  };

  private runFollowup = (): void => {
    this.dispatchEvent(ProgressEvents.followupRun(this.getFormData()));
  };

  private getFormData(): {
    agent: string;
    model: string;
    initialQuestion: string;
  } {
    return {
      agent: this.selectedAgent,
      model: this.selectedModel,
      initialQuestion: this.initialQuestion.trim(),
    };
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'workflow-tool-use-followup-section': WorkflowToolUseFollowupSection;
  }
}
