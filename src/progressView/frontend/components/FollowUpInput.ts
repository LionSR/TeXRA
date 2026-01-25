// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';

// Local imports - shared webview
import { vscode } from '@shared/vscode';

// Local imports - common helpers
import {
  insertTextAtCursor,
  resolveTextareaTarget,
} from '@common/modules/textareaUtils.js';
import { RecordingButtonManager } from '@common/modules/RecordingButtonManager.js';

// Local imports - progress view constants
import { COMMANDS, ELEMENT_IDS } from '../constants';
import { ProgressEvents } from '../events';

// Local imports - progress view components
import './QueuedFollowUps';

@customElement('follow-up-input')
export class FollowUpInput extends LitElement {
  @property({ type: Boolean }) visible = false;
  @property({ type: String }) value = '';
  @property({ type: Array }) queuedMessages: string[] = [];

  @state() private polishing = false;

  @query(`#${ELEMENT_IDS.FOLLOW_UP_INPUT}`)
  declare private textAreaEl: HTMLElement | null;

  private focusTimer: ReturnType<typeof setTimeout> | null = null;

  private recordingManager = new RecordingButtonManager(vscode, {
    buttonId: ELEMENT_IDS.RECORD_FOLLOW_UP_BTN,
    startCommand: COMMANDS.START_RECORDING,
    stopCommand: COMMANDS.STOP_RECORDING,
    startTitle: 'Record follow-up with microphone',
    stopTitle: 'Stop recording',
    root: this,
  });

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  override disconnectedCallback(): void {
    this.clearPendingFocus();
    this.recordingManager.dispose();
    super.disconnectedCallback();
  }

  firstUpdated(): void {
    this.recordingManager.setup();
  }

  /** Handle keyboard events on the textarea - Lit-native pattern */
  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.emitSend();
    }
  };

  render(): TemplateResult | typeof nothing {
    if (!this.visible) {
      return nothing;
    }

    return html`
      <div id=${ELEMENT_IDS.FOLLOW_UP_CONTAINER} class="follow-up-container is-visible">
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
              icon="mic"
              label="Record follow-up"
              title="Record follow-up with microphone"
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

  focusInput(options: { scrollIntoView?: boolean } = {}): void {
    // Clear any pending focus attempt
    this.clearPendingFocus();

    // Don't focus if not visible
    if (!this.visible) return;

    // Debounce focus to prevent multiple rapid focus attempts
    this.focusTimer = setTimeout(() => {
      this.focusTimer = null;

      if (!this.textAreaEl || !this.visible) return;

      const { textarea } = resolveTextareaTarget(this.textAreaEl);
      if (!textarea) return;

      textarea.focus();
      if (options.scrollIntoView) {
        textarea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 50);
  }

  private clearPendingFocus(): void {
    if (this.focusTimer !== null) {
      clearTimeout(this.focusTimer);
      this.focusTimer = null;
    }
  }

  applyPolishedText(text: string): void {
    this.polishing = false;
    this.updateValue(text);
    this.focusInput({ scrollIntoView: true });
  }

  insertTranscription(text: string): void {
    if (!this.textAreaEl) return;

    const { textarea } = resolveTextareaTarget(this.textAreaEl);
    if (!textarea) return;

    insertTextAtCursor(textarea, text);
    this.updateValue(textarea.value);
    this.focusInput({ scrollIntoView: true });
  }

  setRecording(recording: boolean): void {
    this.recordingManager.setRecording(recording);
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
