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
import { designTokens, commonViewStyles } from '@shared/styles';
import type { ToolUseStreamState } from '@shared/schemas';
import { RecordingButtonController } from '@shared/litControllers/RecordingButtonController';
import { getTextareaValue, insertTextAtCursor } from '@shared/utils/textarea';
import {
  clipboardImageFiles,
  getExtensionFromMimeType,
  readFileAsBase64,
  type ExtractedClipboardImage,
} from '@shared/utils/clipboardImages';
import type { UserFollowUpAvailability } from '@shared/streams/followUpCapability';
import { isKnownUnsupported } from '@shared/utils/dispatcher';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { filterNotNullish } from '@utils/core';
import { generatePastedImageName } from '@utils/files/pastedImageName';
import {
  archivedContext,
  followUpEventSinkContext,
  type FollowUpEventSink,
} from '../streamContexts';
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

/** True when any shadow host or light ancestor has `data-desktop-view`. */
function hostHasDesktopViewAttribute(start: Element): boolean {
  let el: Element | null = start;
  while (el) {
    if (el.hasAttribute('data-desktop-view')) return true;
    const root = el.getRootNode();
    el = root instanceof ShadowRoot ? root.host : el.parentElement;
  }
  return false;
}

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
        max-width: 100%;
      }

      /* VS Code only (see useCollapsibleShell): match Todos / Plan chrome. */
      wa-details.panel-collapsible {
        min-width: 0;
      }

      .follow-up-container {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-xs);
        min-width: 0;
      }

      .follow-up-container > queued-follow-ups {
        display: block;
        min-width: 0;
      }

      .composer-surface {
        display: flex;
        flex-direction: column;
        min-width: 0;
        padding: var(--wa-space-3xs);
        border: var(--border-thin) solid var(--wa-color-surface-border);
        border-radius: var(--wa-border-radius-xl, 20px);
        background: var(--wa-color-surface-raised);
        box-shadow:
          0 1px 2px
            color-mix(in srgb, var(--wa-color-surface-shadow) 18%, transparent),
          0 8px 28px
            color-mix(in srgb, var(--wa-color-surface-shadow) 12%, transparent);
        transition:
          border-color var(--transition-fast),
          box-shadow var(--transition-fast);
      }

      .composer-surface:focus-within {
        border-color: color-mix(
          in srgb,
          var(--wa-color-focus) 42%,
          var(--wa-color-surface-border)
        );
        box-shadow:
          0 1px 2px
            color-mix(in srgb, var(--wa-color-surface-shadow) 20%, transparent),
          0 10px 32px
            color-mix(in srgb, var(--wa-color-surface-shadow) 16%, transparent);
      }

      /* The composer rests at two lines and grows with what you type, up to
         the max below, so a substantial instruction still gets room without
         an empty draft reserving it. field-sizing does the growing; the drag
         affordance stays for anyone who wants a taller box than their text.
         Not Web Awesome's resize="auto": that copies the scroll height into an
         invisible grid item which, inside a constrained composer, keeps an
         oversized row for an empty draft. */
      #followUpInput {
        display: block;
        min-width: 0;
        width: 100%;
        box-sizing: border-box;
        line-height: var(--line-height-relaxed);
        height: auto;
        --textarea-min-height: calc(
          2lh + var(--wa-space-xs) + var(--wa-space-3xs)
        );
        --textarea-max-height: clamp(var(--textarea-min-height), 32vh, 240px);
      }

      #followUpInput::part(textarea-wrapper) {
        align-items: start;
        max-height: var(--textarea-max-height);
        overflow: hidden;
        border: 0;
        background: transparent;
        box-shadow: none;
      }

      /* The one place a textarea renders sans rather than mono: this is prose a
         user writes to an agent, not code. */
      #followUpInput::part(textarea) {
        field-sizing: content;
        width: 100%;
        height: auto;
        min-height: var(--textarea-min-height);
        max-height: var(--textarea-max-height);
        padding: var(--wa-space-xs) var(--wa-space-s) var(--wa-space-3xs);
        box-sizing: border-box;
        overflow-x: hidden;
        overflow-y: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-family: var(--wa-font-family-body);
        font-size: var(--font-size);
        line-height: var(--line-height-relaxed);
      }

      .follow-up-error {
        min-height: 1.4em;
        margin: 0;
        padding-inline: var(--wa-space-s);
        color: var(--wa-color-danger-on-quiet);
        font-size: var(--font-size-small);
        line-height: 1.4;
      }

      .follow-up-actions {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: var(--wa-space-3xs);
        min-height: 36px;
        padding: 0 var(--wa-space-3xs) var(--wa-space-3xs);
      }

      /* Composer buttons take the large step off the shared control scale; the
         circular radius is the one local departure, so the send affordance
         reads as a button on a composer rather than a toolbar icon. Fill,
         color, and hover all come from the shared icon-button skin. */
      .follow-up-actions .action-icon-button,
      .follow-up-actions .action-icon-busy {
        --control-size: var(--control-size-l);
      }

      .follow-up-actions .action-icon-busy {
        width: var(--control-size);
        min-width: var(--control-size);
        height: var(--control-size);
      }

      .follow-up-actions .action-icon-button::part(base) {
        border-radius: var(--wa-border-radius-circle);
      }

      .follow-up-actions .recording::part(base) {
        color: var(--wa-color-danger-on-quiet);
        background: var(--wa-color-danger-fill-quiet);
      }

      @container (max-width: 440px) {
        #followUpInput::part(textarea) {
          padding-inline: var(--wa-space-xs);
        }
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

  private readonly inputEventSink: FollowUpEventSink = (event) => {
    this.dispatchEvent(event);
  };

  /** Stable conversation-owned sink retained across this element's unmount. */
  @consume({ context: followUpEventSinkContext })
  private followUpEventSink: FollowUpEventSink = this.inputEventSink;

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
  @property({ attribute: false })
  submission: ToolUseStreamState['ui']['followUpSubmission'] = null;
  @property({ attribute: false })
  availability: UserFollowUpAvailability = {
    available: false,
    reason: 'pending',
    message: 'Wait for this run to start, then try again.',
  };
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

  @query('wa-details')
  declare private detailsEl: (HTMLElement & { open: boolean }) | null;

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
    const eventSink = this.followUpEventSink;
    // Suppress the default paste synchronously, before the async read below.
    event.preventDefault();
    const paste = this.attachPastedImages(
      streamId,
      transientState,
      event,
      files,
      transientState.imagePasteRevision,
      eventSink,
    );
    transientState.pendingImagePastes.add(paste);
    void paste.finally(() => {
      transientState.pendingImagePastes.delete(paste);
      this.flushPendingImagePasteSend(streamId, transientState, eventSink);
    });
  }

  private async attachPastedImages(
    streamId: string,
    transientState: FollowUpInputTransientState,
    event: ClipboardEvent,
    files: Array<{ file: File; type: string }>,
    pasteRevision: number,
    eventSink: FollowUpEventSink,
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
    ).filter(filterNotNullish);
    if (pasteRevision !== transientState.imagePasteRevision) return;
    if (added.length === 0) return;
    const chipText = added.map(({ fileName }) => `[${fileName}]`).join(' ');
    if (insertText && !insertText.endsWith(' ') && !insertText.endsWith('\n')) {
      insertText += ' ';
    }
    insertText += chipText;
    transientState.pendingImages = [...transientState.pendingImages, ...added];
    if (
      this.isConnected &&
      this.streamId === streamId &&
      this.transientState === transientState &&
      this.textAreaEl === target
    ) {
      insertTextAtCursor(target, insertText);
      this.updateValue(
        getTextareaValue(target),
        streamId,
        'replace',
        eventSink,
      );
      return;
    }

    // The input may now be disconnected or display another stream. Preserve
    // the completed paste in its source stream without touching stale DOM.
    this.updateValue(insertText, streamId, 'append', eventSink);
  }

  /**
   * Desktop mounts `<stream-conversation data-desktop-view="progress">` and
   * keeps the composer always open. VS Code Progress Board uses the collapsible
   * shell so the six-line Message box does not permanently own the footer.
   * Walk shadow hosts because FollowUpInput sits under nested shadow roots.
   */
  private get useCollapsibleShell(): boolean {
    return !hostHasDesktopViewAttribute(this);
  }

  override render(): TemplateResult | typeof nothing {
    if (this.archived) return nothing;
    const body = this.renderComposerBody();
    // VS Code only: restore the pre-desktop-modernize wa-details chrome.
    // Desktop already has a roomy conversation pane — leave the composer open,
    // but keep a region landmark so the follow-up area stays named for AT.
    if (!this.useCollapsibleShell) {
      return html` <section aria-label="Follow-up message">${body}</section> `;
    }
    return html`
      <wa-details class="panel-collapsible" summary="Followup">
        ${body}
      </wa-details>
    `;
  }

  private get submissionMessage(): string {
    if (this.submission?.status === 'sending') return 'Sending...';
    if (this.submission?.status === 'failed') return this.submission.error;
    return this.availability.available ? '' : this.availability.message;
  }

  private renderComposerBody(): TemplateResult {
    return html`
      <div id=${ELEMENT_IDS.FOLLOW_UP_CONTAINER} class="follow-up-container">
        ${
          this.queuedMessages.length > 0
            ? html`<queued-follow-ups
                .messages=${this.queuedMessages}
              ></queued-follow-ups>`
            : nothing
        }

        <div class="composer-surface">
          <wa-textarea
            id=${ELEMENT_IDS.FOLLOW_UP_INPUT}
            aria-label="Follow-up message"
            placeholder="Message TeXRA…"
            rows="2"
            resize="vertical"
            .value=${live(this.value)}
            ?disabled=${this.submission?.status === 'sending'}
            aria-busy=${this.submission?.status === 'sending' ? 'true' : 'false'}
            @input=${this.handleInput}
            @keydown=${this.handleKeydown}
            @paste=${this.handlePaste}
          ></wa-textarea>

          <p class="follow-up-error" role="status" aria-live="polite">
            ${this.submissionMessage}
          </p>

          <div class="follow-up-actions">
            ${
              isKnownUnsupported(
                this.unsupportedCommands,
                PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP,
              )
                ? nothing
                : renderIconActionButton({
                    id: ELEMENT_IDS.POLISH_FOLLOW_UP_BTN,
                    icon: 'wand-magic-sparkles',
                    label: 'Polish follow-up',
                    tooltip: 'Polish follow-up with AI',
                    busy: this.polishing,
                    disabled: this.submission?.status === 'sending',
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
                    disabled:
                      this.submission?.status === 'sending' &&
                      !this.recordingController.state.recording,
                    onClick: this.recordingController.handleClick,
                  })
            }
            ${renderIconActionButton({
              id: ELEMENT_IDS.SEND_FOLLOW_UP_BTN,
              icon: 'arrow-up',
              label: 'Send',
              tooltip: 'Send follow-up message',
              className: 'composer-primary-action',
              appearance: 'filled',
              busy: this.submission?.status === 'sending',
              disabled:
                this.submission?.status === 'sending' ||
                !this.availability.available,
              size: 'l',
              onClick: this.emitSend,
            })}
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

    // VS Code collapsible shell: expand so the composer is visible.
    if (this.detailsEl && !this.detailsEl.open) {
      this.detailsEl.open = true;
    }

    // Wait for Lit / wa-details to finish laying out
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
    if (value === '' && this.transientState) {
      // Erasing the whole draft abandons pasted images too; otherwise their
      // base64 payloads stay retained until the stream is sent or deleted.
      resetFollowUpInputTransientState(this.transientState);
    }
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
    eventSink: FollowUpEventSink = this.inputEventSink,
  ): void {
    if (transientState.pendingImagePastes.size > 0) {
      transientState.sendAfterImagePastes = true;
      return;
    }
    eventSink(
      ProgressEvents.followupSend({
        streamId,
        images: transientState.pendingImages,
      }),
    );
    transientState.sendAfterImagePastes = false;
  }

  private flushPendingImagePasteSend(
    streamId: string,
    transientState: FollowUpInputTransientState,
    eventSink: FollowUpEventSink = this.inputEventSink,
  ): void {
    if (
      !transientState.sendAfterImagePastes ||
      transientState.pendingImagePastes.size > 0
    ) {
      return;
    }
    this.emitSendForStream(streamId, transientState, eventSink);
  }

  private emitPolish(): void {
    if (!this.value.trim()) return;
    this.polishing = true;
    this.dispatchEvent(ProgressEvents.followupPolish());
  }

  private updateValue(
    value: string,
    streamId = this.streamId,
    mode: 'replace' | 'append' = 'replace',
    eventSink: FollowUpEventSink = this.inputEventSink,
  ): void {
    if (!streamId) return;
    eventSink(ProgressEvents.followupChange({ streamId, value, mode }));
  }
}
