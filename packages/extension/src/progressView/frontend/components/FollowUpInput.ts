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
import { live } from 'lit/directives/live.js';
import { when } from 'lit/directives/when.js';

// Local imports
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import { RecordingButtonController } from '@shared/controllers';
import { designTokens, commonViewStyles } from '@shared/styles';
import { getTextareaValue, insertTextAtCursor } from '@shared/utils/textarea';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { ELEMENT_IDS } from '../constants';
import { ProgressEvents } from '../events';

// Local imports - progress view components
import './QueuedFollowUps';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/progress-ring/progress-ring.js';

@customElement('follow-up-input')
export class FollowUpInput extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: none;
      }

      :host([visible]) {
        display: block;
        margin-top: var(--spacing-medium);
        max-width: 100%;
      }

      :host([hidden]) {
        display: none;
      }

      .follow-up-container {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        padding: var(--spacing-small) 0;
        gap: var(--spacing-small);
        min-width: 0;
      }

      .follow-up-container > queued-follow-ups {
        display: block;
        grid-column: 1 / -1;
        min-width: 0;
      }

      .follow-up-input-row {
        display: flex;
        align-items: flex-end;
        gap: var(--spacing-small);
        grid-column: 1 / -1;
        min-width: 0;
      }

      #followUpInput {
        display: block;
        flex: 1;
        min-width: 0;
        width: 100%;
        box-sizing: border-box;
        line-height: var(--line-height-normal);
        min-height: 106px;
        max-height: var(--height-xlarge);
        height: auto;
      }

      #followUpInput::part(control) {
        min-height: 106px;
        max-height: var(--height-xlarge);
        width: 100%;
        box-sizing: border-box;
        overflow-x: hidden;
        overflow-y: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .follow-up-actions {
        display: flex;
        flex-direction: column !important;
        align-items: center;
        gap: var(--spacing-small);
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) visible = false;
  @property({ attribute: false }) value = '';
  @property({ attribute: false }) queuedMessages: string[] = [];

  @property({ attribute: false }) shouldFocus = false;
  @property({ attribute: false }) polishedText: string | null = null;
  @property({ attribute: false }) polishRevision = 0;
  @property({ attribute: false }) transcribedText: string | null = null;
  @property({ attribute: false }) recording = false;

  @state() private polishing = false;

  @query(`#${ELEMENT_IDS.FOLLOW_UP_INPUT}`)
  declare private textAreaEl: HTMLElement | null;

  private recordingController = new RecordingButtonController(this, {
    startCommand: PROGRESS_VIEW_COMMANDS.START_RECORDING,
    stopCommand: PROGRESS_VIEW_COMMANDS.STOP_RECORDING,
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

    if (changedProperties.has('polishRevision')) {
      this.polishing = false;
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
          insertTextAtCursor(this.textAreaEl, capturedText);
          this.updateValue(getTextareaValue(this.textAreaEl));
          this.focusInput({ scrollIntoView: true });
        }
      });
    }

    // React to recording property change
    if (changedProperties.has('recording')) {
      this.recordingController.setRecording(this.recording);
    }
  }

  /** Handle keyboard events on the textarea */
  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.emitSend();
    }
  }

  override render(): TemplateResult | typeof nothing {
    return html`
      <wa-details class="panel-collapsible" summary="Follow-up Input">
        <div id=${ELEMENT_IDS.FOLLOW_UP_CONTAINER} class="follow-up-container">
          <queued-follow-ups
            .messages=${this.queuedMessages}
          ></queued-follow-ups>

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
              ${renderIconActionButton({
                id: ELEMENT_IDS.POLISH_FOLLOW_UP_BTN,
                icon: 'sparkle',
                label: 'Polish follow-up',
                title: 'Polish follow-up with AI',
                onClick: this.emitPolish,
              })}
              ${when(
                this.polishing,
                () => html`<wa-progress-ring indeterminate></wa-progress-ring>`,
              )}
              ${renderIconActionButton({
                id: ELEMENT_IDS.RECORD_FOLLOW_UP_BTN,
                icon: this.recordingController.state.icon,
                label: this.recordingController.state.title,
                title: this.recordingController.state.title,
                className: this.recordingController.state.recording
                  ? this.recordingController.state.recordingClass
                  : '',
                onClick: this.recordingController.handleClick,
              })}
              ${renderIconActionButton({
                id: ELEMENT_IDS.CLEAR_FOLLOW_UP_BTN,
                icon: 'clear-all',
                label: 'Clear input',
                title: 'Clear input',
                onClick: this.emitClear,
              })}
              ${renderIconActionButton({
                id: ELEMENT_IDS.SEND_FOLLOW_UP_BTN,
                icon: 'send',
                label: 'Send',
                title: 'Send follow-up message',
                onClick: this.emitSend,
              })}
            </div>
          </div>
        </div>
      </wa-details>
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

    // Focus the host element directly - vscode-textarea handles focus properly
    this.textAreaEl.focus();
    if (options.scrollIntoView) {
      this.textAreaEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  private handleInput(event: InputEvent): void {
    const target = event.currentTarget as HTMLTextAreaElement | null;
    const value = target?.value ?? '';
    this.dispatchEvent(ProgressEvents.followupChange({ value }));
  }

  private emitSend(): void {
    this.dispatchEvent(ProgressEvents.followupSend());
  }

  private emitPolish(): void {
    if (!this.value.trim()) {
      return;
    }
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
