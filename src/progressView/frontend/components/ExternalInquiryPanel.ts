/**
 * UI panel for external inquiry requests.
 *
 * Displays a question formulated by the agent, with a "Copy Question" button
 * for the user to paste into an external AI model (ChatGPT, Gemini, Claude, etc.).
 * Provides a textarea for the user to paste the answer back, and an optional
 * file attachment drop zone for files downloaded from the external model.
 *
 * User input (answer text, dropped files) is persisted in a module-level cache
 * keyed by requestId so it survives component recreation during webview
 * hide/show cycles — the permission is replayed via ApprovalRequestHandler
 * but the component is re-mounted with fresh @state.
 */

import { html, nothing, type TemplateResult, type PropertyValues } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';

import {
  codiconIconClasses,
  commonViewStyles,
  designTokens,
  requestPanelStyles,
} from '@shared/styles';
import type { ExternalInquiryPermission } from '@shared/schemas';
import { EXTERNAL_INQUIRY_ACTIONS } from '@shared/schemas';
import { CopyButtonController } from '@shared/controllers/CopyButtonController';

import { BaseRequestPanel } from './BaseRequestPanel';
import { ProgressEvents } from '../events';

// ── Draft persistence ──

interface InquiryDraft {
  answerText: string;
  droppedFiles: string[];
}

const DRAFT_CACHE_CAP = 50;
const draftCache = new Map<string, InquiryDraft>();
const resolvedIds = new Set<string>();

function evictOldestDraft(): void {
  if (draftCache.size <= DRAFT_CACHE_CAP) return;
  const oldest = draftCache.keys().next().value;
  if (oldest !== undefined) draftCache.delete(oldest);
}

function getRequestId(permission: { data: unknown }): string {
  return (permission.data as ExternalInquiryPermission).requestId;
}

/** Clear draft for a resolved inquiry. Called from eventHandlers on submit/skip. */
export function clearInquiryDraft(requestId: string): void {
  draftCache.delete(requestId);
  resolvedIds.add(requestId);
  // Bound resolvedIds like draftCache
  if (resolvedIds.size > DRAFT_CACHE_CAP) {
    const oldest = resolvedIds.values().next().value;
    if (oldest !== undefined) resolvedIds.delete(oldest);
  }
}

// ── Component ──

@customElement('external-inquiry-panel')
export class ExternalInquiryPanel extends BaseRequestPanel {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconIconClasses,
    requestPanelStyles,
  ];

  @state() private answerText = '';
  @state() private droppedFiles: string[] = [];
  @state() private dropActive = false;

  private copyController = new CopyButtonController(this);
  private draftRestored = false;

  // ── Lifecycle ──

  override disconnectedCallback(): void {
    this.saveDraft();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    // Restore draft once on first update (avoids the extra render from connectedCallback).
    if (!this.draftRestored) {
      this.draftRestored = true;
      const draft = draftCache.get(getRequestId(this.permission));
      if (draft) {
        this.answerText = draft.answerText;
        this.droppedFiles = draft.droppedFiles;
      }
    }
  }

  private saveDraft(): void {
    const id = getRequestId(this.permission);
    if (resolvedIds.has(id)) return;
    if (this.answerText || this.droppedFiles.length > 0) {
      draftCache.set(id, {
        answerText: this.answerText,
        droppedFiles: this.droppedFiles,
      });
      evictOldestDraft();
    } else {
      draftCache.delete(id);
    }
  }

  override handleKeyboardShortcut(_key: string): boolean {
    return false;
  }

  // ── Render ──

  private get hasAnswer(): boolean {
    return this.answerText.trim().length > 0;
  }

  override render(): TemplateResult {
    const data = this.permission.data as ExternalInquiryPermission;

    return html`
      <div class="external-inquiry-request">
        <div class="external-inquiry-request__details">
          ${this.renderHeader(data)}
          ${data.context ? this.renderContext(data.context) : nothing}
          ${this.renderQuestion(data.question)}
          ${data.suggestSearch ? this.renderSearchHint() : nothing}
          ${data.attachFiles?.length
            ? this.renderAttachFiles(data.attachFiles)
            : nothing}
          ${this.renderAnswerArea()} ${this.renderDropZone()}
        </div>
        ${this.renderActions()}
      </div>
    `;
  }

  private renderHeader(data: ExternalInquiryPermission): TemplateResult {
    return html`
      <div class="external-inquiry-request__mode-badge">
        ${data.mode === 'followup' ? 'follow-up' : 'new question'}
      </div>
    `;
  }

  private renderContext(context: string): TemplateResult {
    return html`
      <div class="external-inquiry-request__context">${context}</div>
    `;
  }

  private renderQuestion(question: string): TemplateResult {
    const { copied } = this.copyController.state;

    return html`
      <div class="external-inquiry-request__question">
        <div class="external-inquiry-request__question-text">${question}</div>
        <div class="external-inquiry-request__question-actions">
          <vscode-toolbar-button
            icon=${copied ? 'check' : 'copy'}
            label=${copied ? 'Copied!' : 'Copy Question'}
            title="Copy question to clipboard for pasting into an external AI model"
            @click=${() => this.copyController.copy(question)}
            >${copied ? 'Copied!' : 'Copy Question'}</vscode-toolbar-button
          >
        </div>
      </div>
    `;
  }

  private renderSearchHint(): TemplateResult {
    return html`
      <div class="external-inquiry-request__search-hint">
        <i class="codicon codicon-lightbulb"></i>
        Consider enabling <strong>Search</strong> mode in the external tool for
        this question
      </div>
    `;
  }

  private renderAttachFiles(files: string[]): TemplateResult {
    return html`
      <div class="external-inquiry-request__attach-files">
        <div class="external-inquiry-request__attach-label">
          <i class="codicon codicon-cloud-upload"></i>
          Files to upload to the external model:
        </div>
        <div class="external-inquiry-request__file-list">
          ${files.map(
            (file) => html`
              <div class="external-inquiry-request__file-item">
                <i class="codicon codicon-file"></i>
                <span>${file}</span>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderAnswerArea(): TemplateResult {
    return html`
      <div class="external-inquiry-request__answer-area">
        <div class="external-inquiry-request__answer-label">
          Paste the answer from the external model:
        </div>
        <textarea
          class="external-inquiry-request__answer-input"
          placeholder="Paste the answer here..."
          .value=${live(this.answerText)}
          @input=${this.handleAnswerInput}
          @keydown=${this.handleKeyDown}
        ></textarea>
      </div>
    `;
  }

  private renderDropZone(): TemplateResult {
    return html`
      <div class="external-inquiry-request__answer-area">
        <div class="external-inquiry-request__attach-label">
          <i class="codicon codicon-cloud-download"></i>
          Attach files from external model (optional):
        </div>
        <div
          class=${classMap({
            'external-inquiry-request__drop-zone': true,
            'external-inquiry-request__drop-zone--active': this.dropActive,
          })}
          @dragover=${this.handleDragOver}
          @dragleave=${this.handleDragLeave}
          @drop=${this.handleDrop}
        >
          ${this.droppedFiles.length > 0
            ? this.renderDroppedFiles()
            : html`<span>Drop files here from your file explorer</span>`}
        </div>
      </div>
    `;
  }

  private renderDroppedFiles(): TemplateResult {
    return html`
      <div class="external-inquiry-request__dropped-files">
        ${this.droppedFiles.map(
          (file, idx) => html`
            <div class="external-inquiry-request__dropped-file">
              <i class="codicon codicon-check"></i>
              <span>${file}</span>
              <vscode-toolbar-button
                icon="close"
                title="Remove"
                @click=${() => this.removeFile(idx)}
              ></vscode-toolbar-button>
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderActions(): TemplateResult {
    return html`
      <vscode-toolbar-container class="external-inquiry-request__actions">
        <vscode-toolbar-button
          icon="check"
          label="Submit Answer"
          title="Submit the answer from the external model"
          data-action=${EXTERNAL_INQUIRY_ACTIONS[0]}
          ?disabled=${!this.hasAnswer}
          @click=${this.handleSubmit}
          >Submit Answer</vscode-toolbar-button
        >
        <vscode-toolbar-button
          icon="close"
          label="Skip"
          title="Skip this external inquiry"
          data-action=${EXTERNAL_INQUIRY_ACTIONS[1]}
          @click=${() => this.emitAction(EXTERNAL_INQUIRY_ACTIONS[1])}
          >Skip</vscode-toolbar-button
        >
      </vscode-toolbar-container>
    `;
  }

  // ── Event Handlers ──

  private handleAnswerInput(e: Event): void {
    this.answerText = (e.target as HTMLTextAreaElement).value;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.handleSubmit();
    }
  }

  private handleSubmit(): void {
    const answer = this.answerText.trim();
    if (!answer) return;

    clearInquiryDraft(getRequestId(this.permission));

    this.dispatchEvent(
      ProgressEvents.permissionAction({
        permission: this.permission,
        action: EXTERNAL_INQUIRY_ACTIONS[0],
        answer,
        attachedFiles: this.droppedFiles,
      }),
    );
  }

  private handleDragOver(e: DragEvent): void {
    e.preventDefault();
    if (!this.dropActive) this.dropActive = true;
  }

  private handleDragLeave(): void {
    if (this.dropActive) this.dropActive = false;
  }

  private handleDrop(e: DragEvent): void {
    e.preventDefault();
    this.dropActive = false;
    if (e.dataTransfer?.files) {
      const newFiles = Array.from(e.dataTransfer.files).map((f) => f.name);
      this.droppedFiles = [...this.droppedFiles, ...newFiles];
    }
  }

  private removeFile(index: number): void {
    this.droppedFiles = this.droppedFiles.filter((_, i) => i !== index);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'external-inquiry-panel': ExternalInquiryPanel;
  }
}
