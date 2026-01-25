// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';

// Local imports - common helpers
import {
  awaitTextareaUpgrade,
  insertTextAtCursor,
  resolveTextareaTarget,
} from '@common/modules/textareaUtils.js';
import { RecordingButtonManager } from '@common/modules/RecordingButtonManager.js';

// Local imports - shared webview
import { vscode } from '@shared/vscode';

// Local imports - progress view constants
import { COMMANDS, ELEMENT_IDS } from '../constants';

// Local imports - progress view components
import './QueuedFollowUps';

@customElement('follow-up-input')
export class FollowUpInput extends LitElement {
  @property({ type: Boolean }) visible = false;
  @property({ type: String }) value = '';
  @property({ type: Boolean }) yoloActive = false;
  @property({ type: Array }) queuedMessages: string[] = [];

  private recordingManager = new RecordingButtonManager(vscode, {
    buttonId: ELEMENT_IDS.RECORD_FOLLOW_UP_BTN,
    startCommand: COMMANDS.START_RECORDING,
    stopCommand: COMMANDS.STOP_RECORDING,
    startTitle: 'Record follow-up with microphone',
    stopTitle: 'Stop recording',
  });

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  firstUpdated(): void {
    const textArea = this.querySelector(
      `#${ELEMENT_IDS.FOLLOW_UP_INPUT}`,
    ) as HTMLElement | null;
    if (!textArea) return;

    awaitTextareaUpgrade(textArea, () => {
      const { textarea } = resolveTextareaTarget(textArea);
      if (!textarea) return;

      textarea.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          this.emitSend();
        }
      });
    });

    this.recordingManager.setup();
    this.syncYoloButton();
  }

  updated(): void {
    this.syncYoloButton();
  }

  render(): TemplateResult {
    return html`
      <div
        id=${ELEMENT_IDS.FOLLOW_UP_CONTAINER}
        class="follow-up-container ${this.visible ? 'is-visible' : ''}"
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
              class="yolo-toggle-button"
              icon="shield"
              label="Enable YOLO"
              title="Enable YOLO mode (skip approval prompts)"
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

        <div id="polishFollowUpProgressContainer" style="display: none;">
          Polishing follow-up...
        </div>
      </div>
    `;
  }

  focus(options?: FocusOptions): void {
    this.focusInput();
    if (options) {
      // Keep signature compatible with HTMLElement focus().
    }
  }

  focusInput(options: { scrollIntoView?: boolean } = {}): void {
    const textArea = this.querySelector(
      `#${ELEMENT_IDS.FOLLOW_UP_INPUT}`,
    ) as HTMLElement | null;
    if (!textArea || !this.visible) return;

    const { textarea } = resolveTextareaTarget(textArea);
    if (!textarea) return;

    textarea.focus();
    if (options.scrollIntoView) {
      textarea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  applyPolishedText(text: string): void {
    const progressContainer = this.querySelector(
      '#polishFollowUpProgressContainer',
    ) as HTMLElement | null;
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }
    this.updateValue(text);
    this.focusInput({ scrollIntoView: true });
  }

  insertTranscription(text: string): void {
    const textArea = this.querySelector(
      `#${ELEMENT_IDS.FOLLOW_UP_INPUT}`,
    ) as HTMLElement | null;
    if (!textArea) return;

    const { textarea } = resolveTextareaTarget(textArea);
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
    this.dispatchEvent(
      new CustomEvent('followup-change', {
        detail: { value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitSend(): void {
    this.dispatchEvent(
      new CustomEvent('followup-send', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitPolish(): void {
    const progressContainer = this.querySelector(
      '#polishFollowUpProgressContainer',
    ) as HTMLElement | null;
    if (progressContainer) {
      progressContainer.style.display = 'block';
    }

    this.dispatchEvent(
      new CustomEvent('followup-polish', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitClear(): void {
    this.dispatchEvent(
      new CustomEvent('followup-clear', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitToggleBypass(): void {
    this.dispatchEvent(
      new CustomEvent('followup-toggle-bypass', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private syncYoloButton(): void {
    const button = this.querySelector(
      `#${ELEMENT_IDS.YOLO_TOGGLE_BTN}`,
    ) as HTMLElement | null;
    if (!button) return;

    button.classList.toggle('is-active', this.yoloActive);
    if (this.yoloActive) {
      button.setAttribute('icon', 'flame');
      button.setAttribute('label', 'YOLO mode ON');
      button.setAttribute(
        'title',
        'YOLO mode active - click to disable (resume approval prompts)',
      );
    } else {
      button.setAttribute('icon', 'shield');
      button.setAttribute('label', 'Enable YOLO');
      button.setAttribute('title', 'Enable YOLO mode (skip approval prompts)');
    }
  }

  private updateValue(value: string): void {
    this.dispatchEvent(
      new CustomEvent('followup-change', {
        detail: { value },
        bubbles: true,
        composed: true,
      }),
    );
  }
}
