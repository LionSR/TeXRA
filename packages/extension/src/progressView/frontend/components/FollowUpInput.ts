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
import { consume } from '@lit/context';

// Local imports
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { RecordingButtonController } from '@shared/litControllers';
import { designTokens, commonViewStyles } from '@shared/styles';
import { generatePastedImageName } from '@shared/files/pastedImageConstants';
import { getTextareaValue, insertTextAtCursor } from '@shared/utils/textarea';
import {
  clipboardImageFiles,
  getExtensionFromMimeType,
  readFileAsBase64,
  type ExtractedClipboardImage,
} from '@shared/utils/clipboardImages';
import { isKnownUnsupported } from '@shared/utils/dispatcher';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { archivedContext } from '../contexts/streamContexts';
import { ELEMENT_IDS } from '../constants';
import { ProgressEvents } from '../events';
import {
  resetFollowUpInputTransientState,
  type FollowUpInputTransientState,
} from '../followUpInputState';

// Local imports - progress view components
import './QueuedFollowUps';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';

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
        margin-top: var(--wa-space-xs);
        max-width: 100%;
      }

      :host([hidden]) {
        display: none;
      }

      .follow-up-container {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        padding: var(--wa-space-2xs) 0;
        gap: var(--wa-space-2xs);
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
        gap: var(--wa-space-2xs);
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

      #followUpInput::part(textarea) {
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
        gap: var(--wa-space-2xs);
      }
    `,
  ];

  /**
   * Read-only trace-viewer export: a finished, archived run has nothing to
   * follow up with and no live backend to send it to, so render nothing
   * rather than a functional-looking send box. `<follow-up-input>` renders
   * inside nested shadow roots (stream-conversation > tool-use-stream-content
   * > follow-up-input), so a host-page stylesheet cannot reach it — this has
   * to be an internal check, not host-side CSS.
   */
  @consume({ context: archivedContext, subscribe: true })
  private archived = false;

  @property({ type: Boolean, reflect: true }) visible = false;
  @property({ attribute: false }) value = '';
  @property({ attribute: false }) queuedMessages: string[] = [];
  /** Identity of the stream currently bound to this reused component. */
  @property({ type: String }) streamId = '';
  /** Image draft selected upstream with the same stream key as `value`. */
  @property({ attribute: false })
  transientState: FollowUpInputTransientState | null = null;

  @property({ attribute: false }) shouldFocus = false;
  @property({ attribute: false }) polishedText: string | null = null;
  @property({ attribute: false }) polishRevision = 0;
  @property({ attribute: false }) transcribedText: string | null = null;
  @property({ attribute: false }) recording = false;
  /**
   * Progress-view commands the active host's registry declares
   * `unsupported(...)` (see StreamHeader's `unsupportedCommands` for the
   * same convention). Hides the polish button on a host where
   * POLISH_FOLLOW_UP is unsupported, and the microphone recording button on
   * a host where START_RECORDING is unsupported, instead of leaving a
   * control visible that can only produce an unavailable-command toast.
   */
  @property({ attribute: false })
  unsupportedCommands: ReadonlySet<string> | null = null;

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

  /** Pasting an image stashes its bytes and inserts a `[fileName]` token; the
   *  bytes ride along to the model when the follow-up is sent. Non-image
   *  pastes fall through to the textarea's default text handling. */
  private handlePaste(event: ClipboardEvent): void {
    const files = clipboardImageFiles(event);
    if (files.length === 0) return;
    const streamId = this.streamId;
    const transientState = this.transientState;
    if (!streamId || !transientState) return;
    // Suppress the default paste synchronously, before the async read below.
    event.preventDefault();
    const paste = this.attachPastedImages(
      streamId,
      transientState,
      event,
      files,
      transientState.imagePasteRevision,
    );
    transientState.pendingImagePastes.add(paste);
    void paste.finally(() => {
      transientState.pendingImagePastes.delete(paste);
      this.flushPendingImagePasteSend(streamId, transientState);
    });
  }

  private async attachPastedImages(
    streamId: string,
    transientState: FollowUpInputTransientState,
    event: ClipboardEvent,
    files: Array<{ file: File; type: string }>,
    pasteRevision: number,
  ): Promise<void> {
    const target = this.textAreaEl;
    if (!target) return;
    let insertText = event.clipboardData?.getData('text/plain') || '';
    const added = (
      await Promise.all(
        files.map(
          async ({
            file,
            type,
          }): Promise<ExtractedClipboardImage | undefined> => {
            const base64 = await readFileAsBase64(file);
            if (!base64) return undefined;
            return {
              fileName: generatePastedImageName(getExtensionFromMimeType(type)),
              base64,
              mediaType: type,
            };
          },
        ),
      )
    ).filter((image): image is ExtractedClipboardImage => image !== undefined);
    if (pasteRevision !== transientState.imagePasteRevision) return;
    if (added.length === 0) return;
    const chipText = added.map(({ fileName }) => `[${fileName}]`).join(' ');
    if (insertText && !insertText.endsWith(' ') && !insertText.endsWith('\n')) {
      insertText += ' ';
    }
    insertText += chipText;
    transientState.pendingImages = [...transientState.pendingImages, ...added];
    if (
      this.streamId === streamId &&
      this.transientState === transientState &&
      this.textAreaEl === target
    ) {
      insertTextAtCursor(target, insertText);
      this.updateValue(getTextareaValue(target), streamId);
      return;
    }

    // The shared Lit instance may now display another stream. Preserve the
    // completed paste in its source stream without touching the active box.
    this.updateValue(insertText, streamId, 'append');
  }

  override render(): TemplateResult | typeof nothing {
    if (this.archived) return nothing;
    return html`
      <wa-details class="panel-collapsible" summary="Followup">
        <div id=${ELEMENT_IDS.FOLLOW_UP_CONTAINER} class="follow-up-container">
          <queued-follow-ups
            .messages=${this.queuedMessages}
          ></queued-follow-ups>

          <div class="follow-up-input-row">
            <wa-textarea
              id=${ELEMENT_IDS.FOLLOW_UP_INPUT}
              placeholder="Send follow-up message"
              rows="10"
              resize="vertical"
              .value=${live(this.value)}
              @input=${this.handleInput}
              @keydown=${this.handleKeydown}
              @paste=${this.handlePaste}
            ></wa-textarea>

            <div class="follow-up-actions">
              ${
                isKnownUnsupported(
                  this.unsupportedCommands,
                  PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP,
                )
                  ? nothing
                  : renderIconActionButton({
                      id: ELEMENT_IDS.POLISH_FOLLOW_UP_BTN,
                      icon: 'sparkle',
                      label: 'Polish follow-up',
                      tooltip: 'Polish follow-up with AI',
                      busy: this.polishing,
                      onClick: this.emitPolish,
                    })
              }
              ${
                isKnownUnsupported(
                  this.unsupportedCommands,
                  PROGRESS_VIEW_COMMANDS.START_RECORDING,
                )
                  ? nothing
                  : renderIconActionButton({
                      id: ELEMENT_IDS.RECORD_FOLLOW_UP_BTN,
                      icon: this.recordingController.state.icon,
                      label: this.recordingController.state.title,
                      tooltip: this.recordingController.state.title,
                      className: this.recordingController.state.recording
                        ? this.recordingController.state.recordingClass
                        : '',
                      onClick: this.recordingController.handleClick,
                    })
              }
              ${renderIconActionButton({
                id: ELEMENT_IDS.CLEAR_FOLLOW_UP_BTN,
                icon: 'clear-all',
                label: 'Clear input',
                tooltip: 'Clear input',
                onClick: this.emitClear,
              })}
              ${renderIconActionButton({
                id: ELEMENT_IDS.SEND_FOLLOW_UP_BTN,
                icon: 'send',
                label: 'Send',
                tooltip: 'Send follow-up message',
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

    // Focus the host element directly - wa-textarea handles focus properly
    this.textAreaEl.focus();
    if (options.scrollIntoView) {
      this.textAreaEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  private handleInput(event: InputEvent): void {
    const target = event.currentTarget as HTMLTextAreaElement | null;
    const value = target?.value ?? '';
    this.updateValue(value);
  }

  private emitSend(): void {
    const streamId = this.streamId;
    const transientState = this.transientState;
    if (!streamId || !transientState) return;
    this.emitSendForStream(streamId, transientState);
  }

  private emitSendForStream(
    streamId: string,
    transientState: FollowUpInputTransientState,
  ): void {
    if (transientState.pendingImagePastes.size > 0) {
      transientState.sendAfterImagePastes = true;
      return;
    }
    this.dispatchEvent(
      ProgressEvents.followupSend({
        streamId,
        images: transientState.pendingImages,
      }),
    );
    transientState.pendingImages = [];
    transientState.sendAfterImagePastes = false;
  }

  private flushPendingImagePasteSend(
    streamId: string,
    transientState: FollowUpInputTransientState,
  ): void {
    if (
      !transientState.sendAfterImagePastes ||
      transientState.pendingImagePastes.size > 0
    ) {
      return;
    }
    this.emitSendForStream(streamId, transientState);
  }

  private emitPolish(): void {
    if (!this.value.trim()) {
      return;
    }
    this.polishing = true;
    this.dispatchEvent(ProgressEvents.followupPolish());
  }

  private emitClear(): void {
    const streamId = this.streamId;
    const transientState = this.transientState;
    if (!streamId || !transientState) return;
    resetFollowUpInputTransientState(transientState);
    this.dispatchEvent(ProgressEvents.followupClear({ streamId }));
  }

  private updateValue(
    value: string,
    streamId = this.streamId,
    mode: 'replace' | 'append' = 'replace',
  ): void {
    if (!streamId) return;
    this.dispatchEvent(
      ProgressEvents.followupChange({ streamId, value, mode }),
    );
  }
}
