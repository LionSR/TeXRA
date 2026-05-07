import {
  LitElement,
  css,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { STREAM_STATUS, type StreamStatus } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';
import { selectStyles } from '@shared/styles/selectStyles';
import {
  renderAgentOptions,
  renderModelOptions,
} from '@shared/utils/selectTemplates';

import { ProgressEvents } from '../events';
import type { FollowupOptionsState } from '../store';

@customElement('workflow-tool-use-followup-section')
export class WorkflowToolUseFollowupSection extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconIconClasses,
    selectStyles,
    css`
      :host {
        display: block;
      }

      .followup {
        border-top: var(--border-thin) solid var(--color-border);
        padding: var(--spacing-small) 0;
        color: var(--color-text-secondary);
      }

      .followup__header {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        width: 100%;
        padding: 0;
        border: none;
        background: transparent;
        color: var(--color-text);
        cursor: pointer;
      }

      .followup__title {
        flex: 1;
        text-align: left;
        font-weight: var(--font-weight-medium);
      }

      .followup__body {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-small);
        margin-top: var(--spacing-small);
      }

      .followup__description {
        line-height: 1.4;
      }

      .followup__controls {
        display: grid;
        grid-template-columns: minmax(160px, 1fr) minmax(160px, 1fr);
        gap: var(--spacing-small);
      }

      .followup__field {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-tiny);
        min-width: 0;
      }

      .followup__label {
        font-size: var(--font-size-small);
        color: var(--color-text-secondary);
      }

      vscode-textarea {
        width: 100%;
      }

      .followup__actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--spacing-small);
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

  @state() private expanded = false;
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
      <div
        class="followup"
        role="region"
        aria-label="Workflow tool-use follow-up"
      >
        <button
          class="followup__header"
          type="button"
          aria-expanded=${this.expanded ? 'true' : 'false'}
          @click=${this.toggleExpanded}
        >
          <i
            class=${`codicon codicon-chevron-${this.expanded ? 'down' : 'right'}`}
            aria-hidden="true"
          ></i>
          <span class="followup__title">Tool-use follow-up</span>
          <i class="codicon codicon-comment-discussion" aria-hidden="true"></i>
        </button>

        ${this.expanded
          ? html`
              <div class="followup__body">
                <div class="followup__description">
                  Start an interactive tool-use chat from this workflow result.
                  The new chat gets the workflow output locations and your note
                  as context.
                </div>
                <div class="followup__controls">
                  <label class="followup__field">
                    <span class="followup__label">Agent</span>
                    <vscode-single-select
                      position="above"
                      aria-label="Follow-up tool-use agent"
                      .value=${this.selectedAgent}
                      ?disabled=${agents.length === 0}
                      @change=${this.handleAgentChange}
                    >
                      ${renderAgentOptions(agents, this.selectedAgent)}
                    </vscode-single-select>
                  </label>
                  <label class="followup__field">
                    <span class="followup__label">Model</span>
                    <vscode-single-select
                      position="above"
                      aria-label="Follow-up model"
                      .value=${this.selectedModel}
                      ?disabled=${models.length === 0}
                      @change=${this.handleModelChange}
                    >
                      ${renderModelOptions(models, this.selectedModel)}
                    </vscode-single-select>
                  </label>
                </div>
                <vscode-textarea
                  aria-label="Follow-up note"
                  placeholder="Ask what the tool-use agent should do with these results."
                  rows="3"
                  resize="vertical"
                  .value=${this.initialQuestion}
                  @input=${this.handleQuestionInput}
                ></vscode-textarea>
                <div class="followup__actions">
                  <vscode-button
                    appearance="secondary"
                    ?disabled=${!ready}
                    @click=${this.setupFollowup}
                  >
                    <span slot="start" class="codicon codicon-reply"></span>
                    Setup
                  </vscode-button>
                  <vscode-button
                    appearance="primary"
                    ?disabled=${!ready}
                    @click=${this.runFollowup}
                  >
                    <span slot="start" class="codicon codicon-play"></span>
                    Run
                  </vscode-button>
                </div>
              </div>
            `
          : nothing}
      </div>
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

  private toggleExpanded = (): void => {
    this.expanded = !this.expanded;
    if (this.expanded) {
      this.dispatchEvent(ProgressEvents.followupRequestOptions());
    }
  };

  private handleAgentChange = (event: Event): void => {
    this.selectedAgent = (event.currentTarget as HTMLSelectElement).value;
  };

  private handleModelChange = (event: Event): void => {
    this.selectedModel = (event.currentTarget as HTMLSelectElement).value;
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
