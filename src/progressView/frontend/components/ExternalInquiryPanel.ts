/**
 * UI panel for external inquiry requests.
 *
 * Displays a question formulated by the agent, with a "Copy Question" button
 * for the user to paste into an external AI model (ChatGPT, Gemini, Claude, etc.).
 * Provides a textarea for the user to paste the answer back, and an optional
 * file attachment drop zone for files downloaded from the external model.
 */

import { html, nothing, type TemplateResult } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';

import {
  codiconIconClasses,
  commonViewStyles,
  designTokens,
  requestPanelStyles,
} from '@shared/styles';
import type { ExternalInquiryPermission } from '@shared/schemas';
import { CopyButtonController } from '@shared/controllers/CopyButtonController';

import { BaseRequestPanel } from './BaseRequestPanel';

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

  @query('.external-inquiry-request__answer-input')
  private answerInput?: HTMLTextAreaElement;

  private copyController = new CopyButtonController(this);

  override handleKeyboardShortcut(_key: string): boolean {
    // No single-key shortcuts — the textarea needs all keys
    return false;
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
          ${data.attachFiles?.length ? this.renderAttachFiles(data.attachFiles) : nothing}
          ${this.renderAnswerArea()}
          ${this.renderDropZone()}
        </div>
        ${this.renderActions()}
      </div>
    `;
  }

  private renderHeader(data: ExternalInquiryPermission): TemplateResult {
    return html`
      <div style="display: flex; align-items: center; gap: var(--spacing-small); flex-wrap: wrap;">
        <span class="external-inquiry-request__mode-badge">
          ${data.mode === 'followup' ? 'follow-up' : 'new question'}
        </span>
      </div>
    `;
  }

  private renderContext(context: string): TemplateResult {
    return html`
      <div class="external-inquiry-request__context">${context}</div>
    `;
  }

  private renderQuestion(question: string): TemplateResult {
    const copyIcon = this.copyController.state.copied ? 'check' : 'copy';
    const copyLabel = this.copyController.state.copied ? 'Copied!' : 'Copy Question';

    return html`
      <div class="external-inquiry-request__question">
        <div class="external-inquiry-request__question-text">${question}</div>
        <div class="external-inquiry-request__question-actions">
          <vscode-toolbar-button
            icon=${copyIcon}
            label=${copyLabel}
            title="Copy question to clipboard for pasting into an external AI model"
            @click=${() => this.handleCopy(question)}
          >${copyLabel}</vscode-toolbar-button>
        </div>
      </div>
    `;
  }

  private renderSearchHint(): TemplateResult {
    return html`
      <div class="external-inquiry-request__search-hint">
        <i class="codicon codicon-lightbulb"></i>
        Consider enabling <strong>Search</strong> mode in the external tool for this question
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
          .value=${this.answerText}
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
          class="external-inquiry-request__drop-zone ${this.dropActive ? 'external-inquiry-request__drop-zone--active' : ''}"
          @dragover=${this.handleDragOver}
          @dragleave=${this.handleDragLeave}
          @drop=${this.handleDrop}
        >
          ${this.droppedFiles.length > 0
            ? this.renderDroppedFiles()
            : html`<span>Drop files here or use the browse button</span>`}
          <vscode-toolbar-button
            icon="folder-opened"
            label="Browse..."
            title="Browse for files downloaded from the external model"
            @click=${this.handleBrowse}
          >Browse...</vscode-toolbar-button>
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
    const hasAnswer = this.answerText.trim().length > 0;

    return html`
      <vscode-toolbar-container class="external-inquiry-request__actions">
        <vscode-toolbar-button
          icon="check"
          label="Submit Answer"
          title="Submit the answer from the external model"
          data-action="submit"
          ?disabled=${!hasAnswer}
          @click=${() => this.handleSubmit()}
        >Submit Answer</vscode-toolbar-button>
        <vscode-toolbar-button
          icon="close"
          label="Skip"
          title="Skip this external inquiry"
          data-action="skip"
          @click=${() => this.emitAction('skip')}
        >Skip</vscode-toolbar-button>
      </vscode-toolbar-container>
    `;
  }

  // ── Event Handlers ──

  private handleCopy(text: string): void {
    void this.copyController.copy(text);
  }

  private handleAnswerInput(e: Event): void {
    const target = e.target as HTMLTextAreaElement;
    this.answerText = target.value;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Ctrl/Cmd+Enter to submit
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (this.answerText.trim()) {
        this.handleSubmit();
      }
    }
  }

  private handleSubmit(): void {
    if (!this.answerText.trim()) return;
    // Emit a custom action with the answer text and attached files
    // The action is 'submit' and we pass answer data via the feedback field
    // and files via modelOverride (repurposed for this panel type)
    this.dispatchEvent(
      new CustomEvent('inquiry-submit', {
        bubbles: true,
        composed: true,
        detail: {
          permission: this.permission,
          action: 'submit',
          answer: this.answerText,
          attachedFiles: this.droppedFiles,
        },
      }),
    );
  }

  private handleDragOver(e: DragEvent): void {
    e.preventDefault();
    this.dropActive = true;
  }

  private handleDragLeave(): void {
    this.dropActive = false;
  }

  private handleDrop(e: DragEvent): void {
    e.preventDefault();
    this.dropActive = false;
    if (e.dataTransfer?.files) {
      for (const file of Array.from(e.dataTransfer.files)) {
        this.droppedFiles = [...this.droppedFiles, file.name];
      }
    }
  }

  private handleBrowse(): void {
    // In VS Code webview, file browsing requires posting a message to the extension host.
    // For now, emit an event that the parent can handle.
    this.dispatchEvent(
      new CustomEvent('inquiry-browse-files', {
        bubbles: true,
        composed: true,
        detail: { permission: this.permission },
      }),
    );
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
