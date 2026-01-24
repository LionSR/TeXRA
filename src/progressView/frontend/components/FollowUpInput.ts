// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';
import { when } from 'lit/directives/when.js';

@customElement('follow-up-input')
export class FollowUpInput extends LitElement {
  @property({ type: String }) streamId: string | null = null;
  @property({ type: String }) value = '';
  @property({ type: Boolean }) visible = false;
  @property({ type: Boolean }) bypassActive = false;
  @property({ type: Boolean }) recording = false;
  @property({ type: Boolean }) polishing = false;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  private handleInput(event: Event) {
    const target = event.target as HTMLTextAreaElement | null;
    this.dispatchEvent(
      new CustomEvent('followup-input-change', {
        detail: { text: target?.value ?? '' },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleSend() {
    this.dispatchEvent(
      new CustomEvent('send-followup', {
        detail: { text: this.value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handlePolish() {
    this.dispatchEvent(
      new CustomEvent('polish-followup', {
        detail: { text: this.value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleClear() {
    this.dispatchEvent(
      new CustomEvent('clear-followup', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleToggleBypass() {
    this.dispatchEvent(
      new CustomEvent('toggle-bypass', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleRecordToggle() {
    this.dispatchEvent(
      new CustomEvent('toggle-recording', {
        detail: { recording: !this.recording },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.handleSend();
    }
  }

  override render() {
    const containerClasses = classMap({
      'follow-up-container': true,
      'is-visible': this.visible,
    });

    const yoloIcon = this.bypassActive ? 'flame' : 'shield';
    const yoloLabel = this.bypassActive ? 'YOLO mode ON' : 'Enable YOLO';
    const yoloTitle = this.bypassActive
      ? 'YOLO mode active - click to disable (resume approval prompts)'
      : 'Enable YOLO mode (skip approval prompts)';

    const recordIcon = this.recording ? 'stop-circle' : 'mic';
    const recordTitle = this.recording
      ? 'Stop recording'
      : 'Record follow-up with microphone';

    return html`
      <div
        class=${containerClasses}
        id="followUpContainer"
        aria-hidden=${this.visible ? 'false' : 'true'}
      >
        <slot name="queued"></slot>
        <div class="follow-up-input-row">
          <vscode-text-area
            id="followUpInput"
            class="follow-up-input"
            .value=${live(this.value)}
            placeholder="Add a follow-up..."
            @input=${this.handleInput}
            @keydown=${this.handleKeydown}
          ></vscode-text-area>
          <div class="follow-up-actions">
            <vscode-toolbar-button
              id="recordFollowUpBtn"
              icon=${recordIcon}
              title=${recordTitle}
              aria-label=${recordTitle}
              class=${classMap({ recording: this.recording })}
              @click=${this.handleRecordToggle}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="yoloToggleBtn"
              class=${classMap({
                'yolo-toggle-button': true,
                'is-active': this.bypassActive,
              })}
              icon=${yoloIcon}
              title=${yoloTitle}
              aria-label=${yoloLabel}
              @click=${this.handleToggleBypass}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="polishFollowUpBtn"
              icon="sparkle"
              title="Polish follow-up"
              aria-label="Polish follow-up"
              ?disabled=${!this.value.trim()}
              @click=${this.handlePolish}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="clearFollowUpBtn"
              icon="clear-all"
              title="Clear follow-up"
              aria-label="Clear follow-up"
              @click=${this.handleClear}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="sendFollowUpBtn"
              icon="send"
              title="Send follow-up"
              aria-label="Send follow-up"
              ?disabled=${!this.value.trim()}
              @click=${this.handleSend}
            ></vscode-toolbar-button>
          </div>
        </div>
        ${when(
          this.polishing,
          () => html`
            <div id="polishFollowUpProgressContainer" class="polish-progress">
              Polishing follow-up...
            </div>
          `,
        )}
      </div>
    `;
  }
}
