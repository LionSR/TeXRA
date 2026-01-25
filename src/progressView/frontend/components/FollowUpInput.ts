// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';

// Local imports - shared webview
import { vscode } from '@shared/vscode';

// Local imports - common helpers
import {
  awaitTextareaUpgrade,
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
  @property({ type: Boolean }) yoloActive = false;
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
    if (!this.textAreaEl) return;

    awaitTextareaUpgrade(this.textAreaEl, () => {
      const { textarea } = resolveTextareaTarget(this.textAreaEl!);
      if (!textarea) return;

      textarea.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          this.emitSend();
        }
      });
    });

    this.recordingManager.setup();
  }

  render(): TemplateResult {
    const yoloIcon = this.yoloActive ? 'flame' : 'shield';
    const yoloLabel = this.yoloActive ? 'YOLO mode ON' : 'Enable YOLO';
    const yoloTitle = this.yoloActive
      ? 'YOLO mode active - click to disable (resume approval prompts)'
      : 'Enable YOLO mode (skip approval prompts)';

    return html`
      <div
        id=${ELEMENT_IDS.FOLLOW_UP_CONTAINER}
        class=${classMap({
          'follow-up-container': true,
          'is-visible': this.visible,
        })}
        aria-hidden=${this.visible ? 'false' : 'true'}
      >
        <queued-follow-ups .messages=${this.queuedMessages}></queued-follow-ups>

        <div class="follow-up-input-row">
          <vscode-text-area
            id=${ELEMENT_IDS.FOLLOW_UP_INPUT}
            placeholder="Ask a follow-up..."
            .value=${live(this.value)}
            @input=${this.handleInput}
          ></vscode-text-area>

          <vscode-toolbar-container class="follow-up-actions">
            <vscode-toolbar-button
              id=${ELEMENT_IDS.RECORD_FOLLOW_UP_BTN}
              icon="mic"
              label="Record"
              title="Record follow-up with microphone"
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id=${ELEMENT_IDS.YOLO_TOGGLE_BTN}
              class=${classMap({
                'yolo-toggle-button': true,
                'is-active': this.yoloActive,
              })}
              icon=${yoloIcon}
              label=${yoloLabel}
              title=${yoloTitle}
              @click=${this.emitToggleBypass}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id=${ELEMENT_IDS.POLISH_FOLLOW_UP_BTN}
              icon="sparkle"
              label="Polish"
              title="Polish follow-up text"
              @click=${this.emitPolish}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id=${ELEMENT_IDS.CLEAR_FOLLOW_UP_BTN}
              icon="clear-all"
              label="Clear"
              title="Clear follow-up"
              @click=${this.emitClear}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id=${ELEMENT_IDS.SEND_FOLLOW_UP_BTN}
              icon="send"
              label="Send"
              title="Send follow-up"
              @click=${this.emitSend}
            ></vscode-toolbar-button>
          </vscode-toolbar-container>
        </div>

        <div
          id="polishFollowUpProgressContainer"
          class=${classMap({ 'is-visible': this.polishing })}
          ?hidden=${!this.polishing}
        >
          Polishing follow-up...
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

  private emitToggleBypass(): void {
    this.dispatchEvent(ProgressEvents.followupToggleBypass());
  }

  private updateValue(value: string): void {
    this.dispatchEvent(ProgressEvents.followupChange({ value }));
  }
}
