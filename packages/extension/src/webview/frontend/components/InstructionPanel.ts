/**
 * InstructionPanel component for MainView instruction input.
 *
 * Renders the instruction textarea with session type toggle,
 * action buttons, agent/model selectors, and execute button.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { keyed } from 'lit/directives/keyed.js';
import { styleMap } from 'lit/directives/style-map.js';

// Local imports - shared schemas and types
import type { AgentOptionData, ModelOptionData } from '@shared/schemas';

// Local imports - shared styles
import { designTokens } from '@shared/styles';
import { commonViewStyles } from '@shared/styles/commonViewStyles';
import { selectStyles } from '@shared/styles/selectStyles';

// Local imports - shared utils
import {
  renderAgentOptions,
  renderModelOptions,
} from '@shared/utils/selectTemplates';
import { getTextareaValue } from '@shared/utils/textarea';
import { renderIconActionButton } from '@shared/wa/actionButtons';

// Local imports - main view
import { MainViewEvents } from '../events';
import {
  extractDroppedFilePaths,
  hasDroppedFilePayload,
  postDroppedFiles,
} from '../fileDropHandler';
import { handleImagePaste } from '../pasteHandler';
import { SESSION_TYPES, type SessionType } from '../constants';
import {
  sessionContext,
  type SessionContextValue,
} from '../contexts/mainViewContexts';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';
import '@awesome.me/webawesome/dist/components/radio/radio.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';

type SessionHintKey = SessionType | 'orchestrator';

const SESSION_HINT_COPY: Record<
  SessionHintKey,
  { lede: string; body: string; time: string; ariaLabel: string }
> = {
  workflow: {
    lede: 'Deep pass.',
    body: 'Drafts, reviews its own work, then revises — across your whole document.',
    time: 'Typically 5–10 min on fast models, 10–30 min on frontier reasoning. Pick a smaller model if you need faster turnaround.',
    ariaLabel: 'About workflow mode',
  },
  toolUse: {
    lede: 'Conversational.',
    body: 'Reads, edits, and searches in a running dialogue you steer turn by turn.',
    time: 'Turns stream back in seconds; tool-heavy runs take a minute or two. Pick a stronger model for longer chains of reasoning.',
    ariaLabel: 'About interactive mode',
  },
  orchestrator: {
    lede: 'Orchestrator.',
    body: 'Plans a pipeline of specialized agents and dispatches them for you. Name agents to steer delegation, or ask it which one to use.',
    time: 'E.g., “use polish on the intro, then review the math” — or leave it blank. Approve tasks in Progress as they arrive.',
    ariaLabel: 'About orchestrator mode',
  },
};

function getSessionTitle(type: SessionType): string {
  const copy = SESSION_HINT_COPY[type];
  return `${copy.lede} ${copy.body}`;
}

function resolveSessionHintKey(session: SessionContextValue): SessionHintKey {
  if (session.sessionType === SESSION_TYPES.TOOL_USE) {
    const opt = session.toolUseAgentOptions.find(
      (o) => o.value === session.toolUseAgent,
    );
    if (opt?.isOrchestrator) return 'orchestrator';
  }
  return session.sessionType;
}

@customElement('instruction-panel')
export class InstructionPanel extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    selectStyles,
    css`
      :host {
        display: block;
        /* Both agent + model selects share this width so the two boxes are
           identical at every viewport. clamp() floors at the min so the
           formula can't go negative on viewports < 12rem. */
        --agent-select-max-width: clamp(7rem, calc((100vw - 12rem) / 2), 12rem);
        --agent-model-listbox-min-width: 12rem;
        --agent-model-listbox-max-width: min(
          20rem,
          calc(100vw - var(--wa-space-l))
        );
      }

      .instruction-box {
        display: flex;
        flex-direction: column;
        position: relative;
        padding: var(--wa-space-3xs) var(--wa-space-xs);
        background-color: var(--background-color);
        border-radius: var(--border-radius);
        margin-bottom: var(--wa-space-3xs);
        border: var(--border-thin) solid var(--color-border);
      }

      .instruction-box:focus-within {
        border-color: color-mix(
          in srgb,
          var(--wa-color-brand-fill-loud) 35%,
          var(--color-border)
        );
      }

      .instruction-box.drop-active {
        border-color: var(--wa-color-brand-fill-loud);
      }

      .instruction-box.drop-active::after {
        content: 'Drop to attach';
        position: absolute;
        inset: var(--wa-space-3xs);
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px dashed var(--wa-color-brand-fill-loud);
        border-radius: var(--border-radius);
        background: color-mix(
          in srgb,
          var(--wa-color-surface-default) 78%,
          transparent
        );
        color: var(--wa-color-text-normal);
        font-size: var(--font-size-sm);
        font-weight: 600;
        pointer-events: none;
      }

      .instruction-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--wa-space-2xs);
        margin-bottom: var(--wa-space-3xs);
        line-height: var(--line-height-normal);
        flex-wrap: wrap;
        min-height: 22px;
      }

      .instruction-header-leading {
        display: flex;
        gap: var(--wa-space-2xs);
        align-items: center;
        flex-wrap: wrap;
      }

      .instruction-header-actions {
        display: flex;
        gap: var(--wa-space-3xs);
        align-items: center;
      }

      .instruction-session-toggle {
        display: flex;
        align-items: center;
      }

      .instruction-session-toggle wa-radio-group {
        display: flex;
        gap: var(--wa-space-2xs);
      }

      .instruction-session-toggle wa-radio {
        font-size: var(--font-size-sm);
      }

      .session-hint {
        display: flex;
        gap: var(--wa-space-2xs);
        align-items: flex-start;
        margin-top: var(--wa-space-2xs);
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        border-left: 2px solid
          color-mix(in srgb, var(--wa-color-brand-fill-loud) 70%, transparent);
        background: color-mix(
          in srgb,
          var(--wa-color-brand-fill-quiet) 35%,
          transparent
        );
        border-radius: 0 var(--wa-border-radius-s, 4px)
          var(--wa-border-radius-s, 4px) 0;
        color: var(--wa-color-text-quiet);
        font-size: var(--font-size-sm);
        line-height: var(--line-height-relaxed);
        animation: session-hint-fade 150ms ease;
      }

      @keyframes session-hint-fade {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }

      .session-hint-lede {
        color: var(--wa-color-text-normal);
        font-weight: 600;
        letter-spacing: 0.01em;
        white-space: nowrap;
      }

      .session-hint-body {
        flex: 1 1 auto;
      }

      .session-hint-time {
        color: var(--wa-color-text-quiet);
        opacity: 0.85;
      }

      .session-hint-dismiss {
        flex: 0 0 auto;
        margin-left: var(--wa-space-3xs);
      }

      wa-textarea#instruction {
        width: 100%;
        margin: var(--wa-space-3xs) 0;
        font-family: var(--wa-font-family-mono);
        font-size: var(--font-size);
      }

      wa-textarea#instruction::part(textarea) {
        max-height: var(--height-xlarge);
      }

      .instruction-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--wa-space-2xs);
        flex-wrap: wrap;
        width: 100%;
      }

      .model-selection-footer {
        display: flex;
        align-items: center;
        gap: var(--wa-space-m);
        flex: 1 1 auto;
        flex-wrap: wrap;
        min-width: 0;
      }

      .model-selection-footer .select-group {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        flex: 0 1 auto;
        min-width: 0;
      }

      .model-selection-footer .agent-select-group {
        position: relative;
        flex: 0 0
          calc(
            var(--agent-select-max-width) + var(--height-control) +
              var(--wa-space-2xs)
          );
        min-width: 0;
        max-width: calc(
          var(--agent-select-max-width) + var(--height-control) +
            var(--wa-space-2xs)
        );
      }

      .model-selection-footer .agent-model-select-group {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
      }

      .model-selection-footer .agent-select-group wa-select {
        position: absolute;
        left: calc(var(--height-control) + var(--wa-space-2xs));
        top: 0;
      }

      .model-selection-footer .model-select-group {
        max-width: calc(
          var(--agent-select-max-width) + var(--height-control) +
            var(--wa-space-2xs)
        );
      }

      .model-selection-footer wa-icon,
      .model-selection-footer wa-button {
        display: flex;
        align-items: center;
        line-height: 1;
      }

      .model-selection-footer wa-button {
        min-width: var(--height-control);
        height: var(--height-control);
      }

      /*
       * Execute is the primary action of the entire UI, so it gets a
       * slightly larger, more distinctive treatment than the other
       * footer wa-buttons (which are 24x24 icon-only controls).
       */
      wa-button.execute-button {
        min-width: auto;
        height: auto;
        flex: 0 0 auto;
      }

      wa-button.execute-button::part(base) {
        min-width: 64px;
        min-height: 24px;
        height: 24px;
        padding: 0 var(--wa-space-s);
        gap: var(--wa-space-2xs);
        border-radius: var(--wa-border-radius-m);
        background: var(--wa-color-brand-fill-loud);
        color: var(--wa-color-brand-on-loud);
        border: var(--border-thin) solid
          color-mix(in srgb, black 8%, var(--wa-color-brand-fill-loud));
        font-weight: var(--font-weight-semibold, 600);
        letter-spacing: 0.01em;
      }

      wa-button.execute-button:focus-visible::part(base) {
        outline: 2px solid
          var(--wa-color-focus, var(--wa-color-brand-fill-loud));
        outline-offset: 2px;
      }

      wa-button.execute-button wa-icon {
        font-size: var(--font-size-sm);
      }

      .execute-button__label {
        font-size: var(--font-size-sm);
        line-height: 1;
      }

      /* Lock both selects to identical fixed width. Without flex: 0 0, the
         agent box would shrink/stretch with its label content (e.g.
         "humanize" vs. "🎯 orchestrator ☁"), shifting the model select to
         a different x position between modes. */
      .model-selection-footer .agent-select-group wa-select,
      .model-selection-footer .model-select-group wa-select {
        flex: 0 0 var(--agent-select-max-width);
        width: var(--agent-select-max-width);
        min-width: var(--agent-select-max-width);
        max-width: var(--agent-select-max-width);
        font-size: var(--font-size-sm);
      }

      .model-selection-footer .model-select::part(listbox),
      .model-selection-footer .agent-select::part(listbox) {
        min-width: var(--agent-model-listbox-min-width);
        max-width: var(--agent-model-listbox-max-width);
      }

      /* Footer dropdowns open upward */
      wa-select::part(listbox) {
        bottom: 100%;
        top: auto;
      }

      .recording {
        color: var(--wa-color-danger-on-quiet);
        animation: pulse-record 1.2s ease-in-out infinite;
        transform-origin: center;
      }

      /*
       * Reserve a fixed slot for the polish spinner so the toolbar layout
       * doesn't jump when isPolishing toggles. Width matches the wa-spinner
       * font-size used inside the slot.
       */
      .polish-spinner-slot {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--font-size-icon, 1em);
        height: var(--font-size-icon, 1em);
        opacity: 0;
        transition: opacity var(--transition-fast);
      }

      .polish-spinner-slot[aria-hidden='false'] {
        opacity: 1;
      }

      @keyframes pulse-record {
        0%,
        100% {
          opacity: 1;
          transform: scale(1);
        }
        50% {
          opacity: var(--opacity-disabled);
          transform: scale(1.05);
        }
      }
    `,
  ];

  @consume({ context: sessionContext, subscribe: true })
  private sessionData?: SessionContextValue;

  @property({ type: Boolean }) showSessionHint = true;

  @state()
  private isDragActive = false;

  /** Reference to instruction textarea for paste handling */
  @query('#instruction')
  private instructionTextarea?: HTMLElement;

  private dragDepth = 0;

  /** Get the tooltip for an agent dropdown based on the selected agent's description. */
  private getAgentTooltip(
    options: AgentOptionData[],
    selectedValue: string,
  ): string {
    return options.find((o) => o.value === selectedValue)?.description ?? '';
  }

  /** Get the tooltip for the model dropdown based on the selected model's hint. */
  private getModelTooltip(
    options: ModelOptionData[],
    selectedValue: string,
  ): string {
    return options.find((o) => o.value === selectedValue)?.hint ?? '';
  }

  private renderSessionHint(session: SessionContextValue): unknown {
    if (!this.showSessionHint) return nothing;

    const hintKey = resolveSessionHintKey(session);
    const copy = SESSION_HINT_COPY[hintKey];
    // `keyed` forces the wrapping div to be re-created when the hint key
    // changes, which restarts the `session-hint-fade` CSS animation defined
    // in the host stylesheet so copy swaps cross-fade instead of jump-cutting.
    return keyed(
      hintKey,
      html`
        <div
          class="session-hint"
          role="note"
          data-hint-key=${hintKey}
          aria-label=${copy.ariaLabel}
        >
          <span class="session-hint-lede">${copy.lede}</span>
          <span class="session-hint-body">
            ${copy.body}
            <span class="session-hint-time">${copy.time}</span>
          </span>
          ${renderIconActionButton({
            icon: 'close',
            label: 'Dismiss this reminder',
            title: 'Dismiss this reminder',
            className: 'session-hint-dismiss',
            onClick: this.handleDismissSessionHint,
          })}
        </div>
      `,
    );
  }

  private handleDismissSessionHint(): void {
    this.dispatchEvent(MainViewEvents.dismissSessionHint());
  }

  private handleSessionTypeChange(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    const value =
      target?.value === SESSION_TYPES.WORKFLOW
        ? SESSION_TYPES.WORKFLOW
        : SESSION_TYPES.TOOL_USE;
    this.dispatchEvent(MainViewEvents.sessionTypeChange({ value }));
  }

  private handleAgentChange(event: Event): void {
    const select = event.currentTarget as (WaSelect & HTMLElement) | null;
    if (!select) return;
    const sessionType = select.dataset.sessionType as SessionType;
    const value = typeof select.value === 'string' ? select.value : '';
    this.dispatchEvent(MainViewEvents.agentChange({ sessionType, value }));
  }

  private handleModelChange(event: Event): void {
    const select = event.currentTarget as WaSelect | null;
    const value = typeof select?.value === 'string' ? select.value : '';
    this.dispatchEvent(MainViewEvents.modelChange({ value }));
  }

  private handleInput(event: Event): void {
    const value = (event.currentTarget as HTMLTextAreaElement).value;
    this.dispatchEvent(MainViewEvents.instructionInput({ value }));
  }

  /** Handle paste event on instruction textarea */
  private handleInstructionPaste = async (event: Event): Promise<void> => {
    if (!(event instanceof ClipboardEvent)) return;
    if (!this.instructionTextarea) return;
    const handled = await handleImagePaste(event, this.instructionTextarea);
    if (handled) {
      this.dispatchEvent(
        MainViewEvents.instructionInput({
          value: getTextareaValue(this.instructionTextarea),
        }),
      );
      // Dispatch additional event so parent can save state
      this.dispatchEvent(MainViewEvents.instructionPaste());
    }
  };

  private handleDragEnter(event: DragEvent): void {
    if (!hasDroppedFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    this.dragDepth += 1;
    this.isDragActive = true;
  }

  private handleDragOver(event: DragEvent): void {
    if (!hasDroppedFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  private handleDragLeave(event: DragEvent): void {
    if (!hasDroppedFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.isDragActive = false;
    }
  }

  private handleDrop(event: DragEvent): void {
    if (!hasDroppedFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    this.dragDepth = 0;
    this.isDragActive = false;
    postDroppedFiles(extractDroppedFilePaths(event.dataTransfer));
  }

  private handleActionClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-action]',
    );
    const action = button?.dataset.action;
    if (action) {
      this.dispatchEvent(MainViewEvents.panelAction({ action }));
    }
  }

  private handleExecute(): void {
    this.dispatchEvent(MainViewEvents.execute());
  }

  /**
   * Keyboard-shortcut label shown in the Execute button. Matches the
   * `texra.execute` keybinding declared in the extension's package.json
   * (cmd+option+e on macOS, ctrl+alt+e elsewhere).
   */
  private get executeShortcutLabel(): string {
    const isMac =
      typeof navigator !== 'undefined' &&
      /Mac|iPhone|iPod|iPad/.test(navigator.platform || '');
    return isMac ? '⌘⌥E' : 'Ctrl+Alt+E';
  }

  private handleAgentSettings(): void {
    this.dispatchEvent(MainViewEvents.agentSettings());
  }

  private handleModelSettings(): void {
    this.dispatchEvent(MainViewEvents.modelSettings());
  }

  private handleAgentFocus(): void {
    this.dispatchEvent(
      MainViewEvents.focusInstruction({
        key: 'agentPicker',
        text: 'Select which agent will handle your request.',
      }),
    );
  }

  private handleModelFocus(): void {
    this.dispatchEvent(
      MainViewEvents.focusInstruction({
        key: 'modelPicker',
        text: 'Choose the AI model used by the selected agent.',
      }),
    );
  }

  override render(): TemplateResult | typeof nothing {
    const session = this.sessionData;
    if (!session) {
      return nothing;
    }
    return html`
      <div
        class=${classMap({
          'instruction-box': true,
          'drop-active': this.isDragActive,
        })}
        @dragenter=${this.handleDragEnter}
        @dragover=${this.handleDragOver}
        @dragleave=${this.handleDragLeave}
        @drop=${this.handleDrop}
      >
        <div class="instruction-header">
          <div class="instruction-header-leading">
            <div class="instruction-session-toggle">
              <input
                type="hidden"
                id="sessionType"
                .value=${session.sessionType}
              />
              <wa-radio-group
                id="sessionTypeToggle"
                aria-label="Choose the session type"
                orientation="horizontal"
                .value=${session.sessionType}
                @change=${this.handleSessionTypeChange}
              >
                <wa-radio
                  value="toolUse"
                  data-session-type="toolUse"
                  title=${getSessionTitle(SESSION_TYPES.TOOL_USE)}
                >
                  Interactive
                </wa-radio>
                <wa-radio
                  value="workflow"
                  data-session-type="workflow"
                  title=${getSessionTitle(SESSION_TYPES.WORKFLOW)}
                >
                  Workflow
                </wa-radio>
              </wa-radio-group>
            </div>
          </div>
          <div
            class="instruction-header-actions"
            @click=${this.handleActionClick}
          >
            <span
              style=${styleMap({ display: session.debugMode ? '' : 'none' })}
            >
              ${renderIconActionButton({
                id: 'packButton',
                icon: 'archive',
                label: 'Pack output to History',
                title: 'Pack the output for this agent into the History folder',
                action: 'pack',
              })}
            </span>
            <span
              style=${styleMap({ display: session.debugMode ? '' : 'none' })}
            >
              ${renderIconActionButton({
                id: 'cleanButton',
                icon: 'trash',
                label: 'Clean output',
                title: 'Clean the output for this agent',
                action: 'clean',
              })}
            </span>
            ${renderIconActionButton({
              id: 'magicPolishButton',
              icon: 'sparkle',
              label: 'Polish instruction',
              title: 'Polish instruction text with AI',
              disabled: session.isPolishing,
              action: 'polish',
            })}
            <span
              class="polish-spinner-slot"
              aria-hidden=${session.isPolishing ? 'false' : 'true'}
            >
              ${session.isPolishing
                ? html`
                    <wa-spinner
                      id="polishProgressContainer"
                      style="font-size: var(--font-size-icon, 1em)"
                    ></wa-spinner>
                  `
                : nothing}
            </span>
            ${renderIconActionButton({
              id: 'recordInstructionButton',
              icon: session.isRecording ? 'stop-circle' : 'mic',
              label: 'Record instruction',
              title: session.isRecording
                ? 'Stop recording'
                : 'Record instruction with microphone',
              className: session.isRecording ? 'recording' : '',
              action: 'record',
            })}
            ${renderIconActionButton({
              id: 'eraseInstructionButton',
              icon: 'clear-all',
              label: 'Erase instruction',
              title: 'Erase instruction',
              action: 'erase',
            })}
          </div>
        </div>
        ${this.renderSessionHint(session)}
        <wa-textarea
          id="instruction"
          rows="10"
          resize="none"
          placeholder=${session.placeholder}
          .value=${session.instruction}
          @input=${this.handleInput}
          @paste=${this.handleInstructionPaste}
        ></wa-textarea>
        <div class="instruction-controls">
          <div class="model-selection-footer">
            <div
              class="select-group agent-select-group agent-model-select-group"
            >
              ${renderIconActionButton({
                id: 'agentSettingsButton',
                icon: 'sparkle',
                label: 'Agent settings',
                title: 'Agent settings',
                className: 'settings-button',
                onClick: this.handleAgentSettings,
              })}
              ${session.sessionType === SESSION_TYPES.WORKFLOW
                ? html`
                    <wa-select
                      id="workflowAgent"
                      class="agent-select"
                      data-session-type="workflow"
                      aria-label="Workflow agent"
                      title=${this.getAgentTooltip(
                        session.workflowAgentOptions,
                        session.workflowAgent,
                      ) || nothing}
                      placement="top"
                      placeholder="Agent…"
                      .value=${session.workflowAgent}
                      @focus=${this.handleAgentFocus}
                      @change=${this.handleAgentChange}
                    >
                      ${renderAgentOptions(
                        session.workflowAgentOptions,
                        session.workflowAgent,
                      )}
                    </wa-select>
                  `
                : html`
                    <wa-select
                      id="toolUseAgent"
                      class="agent-select"
                      data-session-type="toolUse"
                      aria-label="Tool-use agent"
                      title=${this.getAgentTooltip(
                        session.toolUseAgentOptions,
                        session.toolUseAgent,
                      ) || nothing}
                      placement="top"
                      placeholder="Agent…"
                      .value=${session.toolUseAgent}
                      @focus=${this.handleAgentFocus}
                      @change=${this.handleAgentChange}
                    >
                      ${renderAgentOptions(
                        session.toolUseAgentOptions,
                        session.toolUseAgent,
                      )}
                    </wa-select>
                  `}
            </div>
            <div
              class="select-group model-select-group agent-model-select-group"
            >
              ${renderIconActionButton({
                id: 'modelSettingsButton',
                icon: 'robot',
                label: 'Model settings',
                title: 'Model settings',
                className: 'settings-button',
                onClick: this.handleModelSettings,
              })}
              <wa-select
                id="model"
                class="model-select"
                placement="top"
                aria-label="Model"
                placeholder="Select model…"
                title=${this.getModelTooltip(
                  session.modelOptions,
                  session.model,
                ) || nothing}
                .value=${session.model}
                @focus=${this.handleModelFocus}
                @change=${this.handleModelChange}
              >
                ${renderModelOptions(session.modelOptions, session.model)}
              </wa-select>
            </div>
          </div>
          <wa-button
            id="executeButton"
            class="execute-button"
            title="Execute (${this.executeShortcutLabel})"
            appearance="filled"
            variant="brand"
            @click=${this.handleExecute}
          >
            <wa-icon slot="start" library="texra" name="play"></wa-icon>
            <span class="execute-button__label">Run</span>
          </wa-button>
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
