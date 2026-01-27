// Third-party imports
import {
  LitElement,
  html,
  css,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';

// Local imports - shared styles
import { commonViewStyles } from '@shared/styles';

// Local imports - shared utilities
import { insertTextAtCursor, resolveTextareaTarget } from '@shared/utils';
import { RecordingButtonController } from '@shared/controllers';

// Local imports - progress view constants
import { COMMANDS, ELEMENT_IDS } from '../constants';
import { ProgressEvents } from '../events';

// Local imports - progress view components
import './QueuedFollowUps';

@customElement('follow-up-input')
export class FollowUpInput extends LitElement {
  static styles = [
    commonViewStyles,
    css`
      :host {
        display: none;
      }

      :host([visible]) {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      .follow-up-container {
        display: grid;
        grid-template-columns: 1fr auto;
        padding: var(--spacing-medium);
        border-top: var(--border-thin) solid var(--color-border);
        gap: var(--spacing-small);
      }

      .follow-up-container > queued-follow-ups {
        display: block;
        grid-column: 1 / -1;
        min-width: 0;
        box-sizing: border-box;
      }

      .follow-up-input-row {
        display: flex;
        align-items: flex-end;
        gap: var(--spacing-small);
        grid-column: 1 / -1;
      }

      #followUpInput {
        display: block;
        flex: 1;
        min-width: 0;
        line-height: 1.4;
        min-height: 106px;
        max-height: var(--height-xlarge);
        height: auto;
      }

      #followUpInput::part(control) {
        min-height: 106px;
        max-height: var(--height-xlarge);
        overflow-y: auto;
      }

      .follow-up-actions,
      vscode-toolbar-container.follow-up-actions {
        display: flex;
        flex-direction: column !important;
        align-items: center;
        gap: var(--spacing-small);
      }

      .polish-progress {
        display: none;
      }

      .polish-progress.is-visible {
        display: block;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) visible = false;
  @property({ type: String }) value = '';
  @property({ type: Array }) queuedMessages: string[] = [];

  // Reactive properties for Lit-native patterns (Phase 9e)
  @property({ type: Boolean }) shouldFocus = false;
  @property({ type: String }) polishedText: string | null = null;
  @property({ type: String }) transcribedText: string | null = null;
  @property({ type: Boolean }) recording = false;

  @state() private polishing = false;

  @query(`#${ELEMENT_IDS.FOLLOW_UP_INPUT}`)
  declare private textAreaEl: HTMLElement | null;

  private recordingController = new RecordingButtonController(this, {
    startCommand: COMMANDS.START_RECORDING,
    stopCommand: COMMANDS.STOP_RECORDING,
    startTitle: 'Record follow-up with microphone',
    stopTitle: 'Stop recording',
  });

  protected override willUpdate(changedProperties: PropertyValues): void {
    // React to shouldFocus property change
    if (changedProperties.has('shouldFocus') && this.shouldFocus) {
      this.focusInput({ scrollIntoView: true }).then(() => {
        // Guard against dispatching events after disconnection
        if (this.isConnected) {
          this.dispatchEvent(ProgressEvents.focusComplete());
        }
      });
    }

    // React to polishedText property change
    if (changedProperties.has('polishedText') && this.polishedText !== null) {
      this.polishing = false;
      this.updateValue(this.polishedText);
      this.focusInput({ scrollIntoView: true });
    }

    // React to transcribedText property change
    if (
      changedProperties.has('transcribedText') &&
      this.transcribedText !== null
    ) {
      // Capture value now - it may be reset by focus-complete before callback runs
      const capturedText = this.transcribedText;
      // We need to wait for the element to be rendered before inserting text
      this.updateComplete.then(() => {
        // Guard against operating on disconnected component
        if (!this.isConnected) return;
        if (this.textAreaEl) {
          const { textarea } = resolveTextareaTarget(this.textAreaEl);
          if (textarea) {
            insertTextAtCursor(textarea, capturedText);
            this.updateValue(textarea.value);
            this.focusInput({ scrollIntoView: true });
          }
        }
      });
    }

    // React to recording property change
    if (changedProperties.has('recording')) {
      this.recordingController.setRecording(this.recording);
    }
  }

  /** Handle keyboard events on the textarea - Lit-native pattern */
  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.emitSend();
    }
  }

  render(): TemplateResult | typeof nothing {
    if (!this.visible) {
      return nothing;
    }

    return html`
      <div id=${ELEMENT_IDS.FOLLOW_UP_CONTAINER} class="follow-up-container">
        <queued-follow-ups .messages=${this.queuedMessages}></queued-follow-ups>

        <div class="follow-up-input-row">
          <vscode-textarea
            id=${ELEMENT_IDS.FOLLOW_UP_INPUT}
            placeholder="Send follow-up message"
            rows="10"
            resize="vertical"
            .value=${live(this.value)}
            @input=${this.handleInput}
            @keydown=${this.handleKeydown}
          ></vscode-textarea>

          <div class="follow-up-actions">
            <vscode-toolbar-button
              id=${ELEMENT_IDS.POLISH_FOLLOW_UP_BTN}
              icon="sparkle"
              label="Polish follow-up"
              title="Polish follow-up with AI"
              @click=${this.emitPolish}
            ></vscode-toolbar-button>
            <vscode-progress-ring
              id="polishFollowUpProgressContainer"
              class=${classMap({
                'polish-progress': true,
                'is-visible': this.polishing,
              })}
              ?hidden=${!this.polishing}
            ></vscode-progress-ring>
            <vscode-toolbar-button
              id=${ELEMENT_IDS.RECORD_FOLLOW_UP_BTN}
              icon=${this.recordingController.state.icon}
              label=${this.recordingController.state.title}
              title=${this.recordingController.state.title}
              class=${classMap({
                [this.recordingController.state.recordingClass]:
                  this.recordingController.state.recording,
              })}
              @click=${this.recordingController.handleClick}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id=${ELEMENT_IDS.CLEAR_FOLLOW_UP_BTN}
              icon="clear-all"
              label="Clear input"
              title="Clear input"
              @click=${this.emitClear}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id=${ELEMENT_IDS.SEND_FOLLOW_UP_BTN}
              icon="send"
              label="Send"
              title="Send follow-up message"
              @click=${this.emitSend}
            ></vscode-toolbar-button>
          </div>
        </div>
      </div>
    `;
  }

  override focus(_options?: FocusOptions): void {
    this.focusInput();
  }

  /** Focus the textarea after Lit finishes rendering */
  async focusInput(options: { scrollIntoView?: boolean } = {}): Promise<void> {
    // Don't focus if not visible
    if (!this.visible) return;

    // Wait for Lit to finish rendering (replaces setTimeout debounce)
    await this.updateComplete;

    if (!this.textAreaEl || !this.visible) return;

    const { textarea } = resolveTextareaTarget(this.textAreaEl);
    if (!textarea) return;

    textarea.focus();
    if (options.scrollIntoView) {
      textarea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  private handleInput(event: InputEvent): void {
    const target = event.target as HTMLTextAreaElement | null;
    const value = target?.value ?? '';
    this.dispatchEvent(ProgressEvents.followupChange({ value }));
  }

  private emitSend(): void {
    this.dispatchEvent(ProgressEvents.followupSend());
  }

  private emitPolish(): void {
    this.polishing = true;
    this.dispatchEvent(ProgressEvents.followupPolish());
  }

  private emitClear(): void {
    this.dispatchEvent(ProgressEvents.followupClear());
  }

  private updateValue(value: string): void {
    this.dispatchEvent(ProgressEvents.followupChange({ value }));
  }
}
