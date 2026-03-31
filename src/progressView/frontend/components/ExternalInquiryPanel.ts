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

import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';

import {
  codiconIconClasses,
  commonViewStyles,
  designTokens,
  requestPanelStyles,
} from '@shared/styles';
import type {
  ExternalInquiryPermission,
  ExternalInquiryUploadedFile,
} from '@shared/schemas';
import {
  EXTERNAL_INQUIRY_ACTIONS,
  EXTERNAL_INQUIRY_MAX_UPLOAD_BYTES,
  EXTERNAL_INQUIRY_MAX_UPLOAD_FILES,
} from '@shared/schemas';
import { CopyButtonController } from '@shared/controllers/CopyButtonController';

import { BaseRequestPanel } from './BaseRequestPanel';
import { ProgressEvents } from '../events';

// ── Draft persistence ──

interface InquiryDraft {
  answerText: string;
  uploadedFiles: ExternalInquiryUploadedFile[];
}

const DRAFT_CACHE_CAP = 50;
const draftCache = new Map<string, InquiryDraft>();
const resolvedIds = new Set<string>();

const ALLOWED_FILE_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.xml',
  '.toml',
  '.log',
  '.tex',
  '.bib',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.html',
  '.css',
  '.scss',
  '.sh',
  '.bash',
  '.zsh',
  '.diff',
  '.patch',
]);

const BLOCKED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'text/rtf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.apple.pages',
  'application/vnd.apple.numbers',
  'application/vnd.apple.keynote',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/octet-stream',
]);

function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
}

function normalizeMediaType(file: File): string {
  return file.type.trim().toLowerCase();
}

function isProbablyTextContent(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;

  let suspiciousControlBytes = 0;

  for (const byte of bytes) {
    if (byte === 0) return false;
    const isControl =
      byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13;
    if (isControl) suspiciousControlBytes += 1;
  }

  return suspiciousControlBytes / bytes.length < 0.05;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error(`Failed to read ${file.name}.`));
        return;
      }
      const base64 = result.split(',')[1];
      if (!base64) {
        reject(new Error(`Failed to encode ${file.name}.`));
        return;
      }
      resolve(base64);
    };

    reader.onerror = () => {
      reject(new Error(`Failed to read ${file.name}.`));
    };

    reader.readAsDataURL(file);
  });
}

function formatUploadSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  return `${(sizeBytes / 1024).toFixed(1)} KB`;
}

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
  @state() private uploadedFiles: ExternalInquiryUploadedFile[] = [];
  @state() private dropActive = false;
  @state() private fileMessage = '';
  @state() private isReadingFiles = false;

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
        this.uploadedFiles = draft.uploadedFiles;
      }
    }
  }

  private saveDraft(): void {
    const id = getRequestId(this.permission);
    if (resolvedIds.has(id)) return;
    if (this.answerText || this.uploadedFiles.length > 0) {
      draftCache.set(id, {
        answerText: this.answerText,
        uploadedFiles: this.uploadedFiles,
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
    return this.answerText.trim().length > 0 && !this.isReadingFiles;
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
          ${this.uploadedFiles.length > 0
            ? this.renderDroppedFiles()
            : html`<span>Drop files here from your file explorer</span>`}
        </div>
        <div class="external-inquiry-request__upload-help">
          Text files only, up to ${EXTERNAL_INQUIRY_MAX_UPLOAD_FILES} files and
          ${(EXTERNAL_INQUIRY_MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)} MiB
          per file.
        </div>
        ${this.fileMessage
          ? html`
              <div class="external-inquiry-request__upload-message">
                <i class="codicon codicon-warning"></i>
                <span>${this.fileMessage}</span>
              </div>
            `
          : nothing}
        ${this.isReadingFiles
          ? html`
              <div class="external-inquiry-request__upload-help">
                Processing files...
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private renderDroppedFiles(): TemplateResult {
    return html`
      <div class="external-inquiry-request__dropped-files">
        ${this.uploadedFiles.map(
          (file, idx) => html`
            <div class="external-inquiry-request__dropped-file">
              <i class="codicon codicon-check"></i>
              <span>
                ${file.fileName} (${formatUploadSize(file.sizeBytes)})
              </span>
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
        uploadedFiles: this.uploadedFiles,
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

  private async handleDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    this.dropActive = false;
    this.fileMessage = '';

    const files = e.dataTransfer?.files ? [...e.dataTransfer.files] : [];
    if (files.length === 0) return;

    if (
      this.uploadedFiles.length + files.length >
      EXTERNAL_INQUIRY_MAX_UPLOAD_FILES
    ) {
      this.fileMessage = `You can attach at most ${EXTERNAL_INQUIRY_MAX_UPLOAD_FILES} files per inquiry.`;
      return;
    }

    this.isReadingFiles = true;
    const nextUploads: ExternalInquiryUploadedFile[] = [];
    const failures: string[] = [];

    for (const file of files) {
      try {
        nextUploads.push(await this.readUploadedFile(file));
      } catch (error) {
        failures.push(
          error instanceof Error
            ? error.message
            : `Failed to read ${file.name}.`,
        );
      }
    }

    this.isReadingFiles = false;

    if (nextUploads.length > 0) {
      this.uploadedFiles = [...this.uploadedFiles, ...nextUploads];
    }

    if (failures.length > 0) {
      this.fileMessage = failures.join(' ');
    }
  }

  private removeFile(index: number): void {
    this.uploadedFiles = this.uploadedFiles.filter((_, i) => i !== index);
    if (this.uploadedFiles.length === 0) {
      this.fileMessage = '';
    }
  }

  private async readUploadedFile(
    file: File,
  ): Promise<ExternalInquiryUploadedFile> {
    if (file.size > EXTERNAL_INQUIRY_MAX_UPLOAD_BYTES) {
      throw new Error(
        `${file.name} exceeds ${(EXTERNAL_INQUIRY_MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)} MiB.`,
      );
    }

    const extension = getExtension(file.name);
    const mediaType = normalizeMediaType(file).toLowerCase();
    const isBlockedMime =
      mediaType.startsWith('image/') ||
      mediaType.startsWith('audio/') ||
      mediaType.startsWith('video/') ||
      BLOCKED_MIME_TYPES.has(mediaType);

    if (!ALLOWED_FILE_EXTENSIONS.has(extension)) {
      throw new Error(
        `${file.name} is not an allowed text/code file for external inquiry uploads.`,
      );
    }

    if (isBlockedMime) {
      throw new Error(`${file.name} is not a supported text file.`);
    }

    const previewBytes = new Uint8Array(
      await file.slice(0, 4096).arrayBuffer(),
    );
    if (!isProbablyTextContent(previewBytes)) {
      throw new Error(`${file.name} looks binary and cannot be uploaded here.`);
    }

    return {
      fileName: file.name,
      mediaType,
      sizeBytes: file.size,
      base64: await readFileAsBase64(file),
    };
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'external-inquiry-panel': ExternalInquiryPanel;
  }
}
