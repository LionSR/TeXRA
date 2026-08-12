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

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  DEFAULT_STREAM_METADATA_STATUS,
  type StreamLifecycleStatus,
} from '@shared/schemas';
import { designTokens, commonViewStyles, selectStyles } from '@shared/styles';
import { isTerminalOutcomePhase } from '@shared/streams/streamStatus';
import {
  isKnownUnsupported,
  UnsupportedCommandsMixin,
} from '@shared/utils/dispatcher';
import {
  readSelectValue,
  renderAgentOptions,
  renderModelOptions,
} from '@shared/utils/selectTemplates';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import { ProgressEvents } from '../events';
import type { FollowupOptionsState } from '../store';

@customElement('workflow-tool-use-followup-section')
export class WorkflowToolUseFollowupSection extends UnsupportedCommandsMixin(LitElement) {
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
        font-size: var(--font-size-sm);
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

      @container (max-width: 600px) {
        .followup__controls {
          grid-template-columns: 1fr;
        }

        .followup__actions {
          flex-wrap: wrap;
        }
      }
    `,
  ];

  @property({ attribute: false }) status: StreamLifecycleStatus | null = null;
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
        summary="Follow-up chat"
        @wa-show=${this.handleShow}
        role="region"
        aria-label="Follow-up chat"
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
                ${renderAgentOptions(agents)}
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
                ${renderModelOptions(models)}
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
              size="s"
              ?disabled=${!ready}
              @click=${this.setupFollowup}
            >
              ${waIcon('reply', { slot: 'start' })} Setup
            </wa-button>
            <wa-button
              appearance="filled"
              variant="brand"
              size="s"
              ?disabled=${!ready}
              @click=${this.runFollowup}
            >
              ${waIcon('play', { slot: 'start' })} Run
            </wa-button>
          </div>
        </div>
      </wa-details>
    `;
  }

  private shouldRender(): boolean {
    return (
      this.hasOutputFiles &&
      !isKnownUnsupported(
        this.unsupportedCommands,
        PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS,
      ) &&
      (this.status == null ||
        this.status === DEFAULT_STREAM_METADATA_STATUS ||
        isTerminalOutcomePhase(this.status))
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
    this.selectedAgent = readSelectValue(event);
  };

  private handleModelChange = (event: Event): void => {
    this.selectedModel = readSelectValue(event);
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
