/**
 * UI panel for external inquiry requests.
 *
 * Displays a question formulated by the agent, with a "Copy Question" button
 * for the user to paste into an external AI model (ChatGPT, Gemini, Claude, etc.).
 * Provides a textarea for the user to paste the answer back.
 *
 * If the external model returns files, the user saves them into the workspace
 * and tells the agent the paths.
 *
 * User input (answer text) is persisted in a module-level cache keyed by
 * requestId so it survives component recreation during webview hide/show
 * cycles — the permission is replayed via ApprovalRequestHandler but the
 * component is re-mounted with fresh @state.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';

import '@awesome.me/webawesome/dist/components/icon/icon.js';

import {
  commonViewStyles,
  designTokens,
  requestPanelStyles,
} from '@shared/styles';
import type { ExternalInquiryPermission } from '@shared/schemas';
import { CopyButtonController } from '@shared/controllers/CopyButtonController';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';

import { BaseFeedbackPanel } from './BaseFeedbackPanel';
import { ProgressEvents } from '../events';

// ── Draft persistence ──

interface InquiryDraft {
  answerText: string;
  sessionLinksText: string;
}

const DRAFT_CACHE_CAP = 50;
const draftCache = new Map<string, InquiryDraft>();
const resolvedIds = new Set<string>();
const INQUIRY_SUBMIT_ACTION = 'submit';

function getRequestId(permission: { data: unknown }): string {
  return (permission.data as ExternalInquiryPermission).requestId;
}

function safeHttpUrl(link: string): string | undefined {
  try {
    const url = new URL(link);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Clear draft for a resolved inquiry. Called from eventHandlers on submit/drop. */
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
export class ExternalInquiryPanel extends BaseFeedbackPanel {
  static override styles = [designTokens, commonViewStyles, requestPanelStyles];

  @state() private answerText = '';
  @state() private sessionLinksText = '';

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
        this.sessionLinksText = draft.sessionLinksText;
      }
    }
  }

  private saveDraft(): void {
    const id = getRequestId(this.permission);
    if (resolvedIds.has(id)) return;
    if (this.answerText || this.sessionLinksText) {
      draftCache.set(id, {
        answerText: this.answerText,
        sessionLinksText: this.sessionLinksText,
      });
      if (draftCache.size > DRAFT_CACHE_CAP) {
        const oldest = draftCache.keys().next().value;
        if (oldest !== undefined) draftCache.delete(oldest);
      }
    } else {
      draftCache.delete(id);
    }
  }

  override handleKeyboardShortcut(key: string): boolean {
    // Suppress the parent's 'y' → approve binding (invalid for external inquiry)
    if (key === 'y') return false;
    return super.handleKeyboardShortcut(key);
  }

  // ── Render ──

  private get hasAnswer(): boolean {
    return this.answerText.trim().length > 0;
  }

  private get normalizedSessionLinks(): string[] {
    return [
      ...new Set(
        this.sessionLinksText
          .split('\n')
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    ];
  }

  override render(): TemplateResult {
    const data = this.permission.data as ExternalInquiryPermission;

    return html`
      <div
        class=${classMap({
          'external-inquiry-request': true,
          'external-inquiry-request--feedback-active': this.showFeedback,
        })}
      >
        <div class="external-inquiry-request__details">
          ${this.renderHeader(data)}
          ${data.context ? this.renderContext(data.context) : nothing}
          ${this.renderQuestion(data.question)}
          ${data.suggestSearch ? this.renderSearchHint() : nothing}
          ${data.attachFiles?.length
            ? this.renderAttachFiles(data.attachFiles)
            : nothing}
          ${this.renderSessionLinks(data.sessionLinks ?? [])}
          ${this.renderAnswerArea()}
          ${this.renderFeedbackSection(
            'external-inquiry-request__feedback',
            'external-inquiry-request__feedback-input',
            'Why are you rejecting this external inquiry?',
          )}
        </div>
        ${this.renderActions()}
      </div>
    `;
  }

  private renderHeader(data: ExternalInquiryPermission): TemplateResult {
    return html`
      <div class="external-inquiry-request__mode-badge">
        ${data.threadId ? 'follow-up' : 'new question'}
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
    const text = copied ? 'Copied!' : 'Copy Question';

    return html`
      <div class="external-inquiry-request__question">
        <div class="external-inquiry-request__question-text">${question}</div>
        <div class="external-inquiry-request__question-actions">
          ${renderLabeledActionButton({
            icon: copied ? 'check' : 'copy',
            text,
            title:
              'Copy question to clipboard for pasting into an external AI model',
            onClick: () => this.copyController.copy(question),
          })}
        </div>
      </div>
    `;
  }

  private renderSearchHint(): TemplateResult {
    return html`
      <div class="external-inquiry-request__search-hint">
        <wa-icon library="texra" name="lightbulb" aria-hidden="true"></wa-icon>
        Consider enabling <strong>Search</strong> mode in the external tool for
        this question
      </div>
    `;
  }

  private renderAttachFiles(files: string[]): TemplateResult {
    return html`
      <div class="external-inquiry-request__attach-files">
        <div class="external-inquiry-request__attach-label">
          <wa-icon
            library="texra"
            name="cloud-upload"
            aria-hidden="true"
          ></wa-icon>
          Files to upload to the external model:
        </div>
        <div class="external-inquiry-request__file-list">
          ${files.map(
            (file) => html`
              <div class="external-inquiry-request__file-item">
                <wa-icon
                  library="texra"
                  name="file"
                  aria-hidden="true"
                ></wa-icon>
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
        <div class="external-inquiry-request__answer-hint">
          If the external model returns files, save them into the workspace and
          tell the agent the paths.
        </div>
      </div>
    `;
  }

  private renderSessionLinks(sessionLinks: string[]): TemplateResult {
    return html`
      <div class="external-inquiry-request__session-links">
        ${sessionLinks.length
          ? html`
              <div class="external-inquiry-request__session-links-known">
                <div class="external-inquiry-request__session-links-label">
                  Known external session links:
                </div>
                <div class="external-inquiry-request__session-links-list">
                  ${repeat(
                    sessionLinks,
                    (link) => link,
                    (link) => this.renderKnownSessionLink(link),
                  )}
                </div>
              </div>
            `
          : nothing}
        <div class="external-inquiry-request__session-links-input-group">
          <div class="external-inquiry-request__session-links-label">
            Save external session link for follow-ups:
          </div>
          <div class="external-inquiry-request__chat-links">
            Open:
            <a
              href="https://chatgpt.com/plans/pro/"
              target="_blank"
              rel="noopener noreferrer"
              >ChatGPT Pro</a
            >
            &nbsp;·&nbsp;
            <a
              href="https://deepmind.google/models/gemini/deep-think/"
              target="_blank"
              rel="noopener noreferrer"
              >Gemini Deep Think</a
            >
          </div>
          <textarea
            class="external-inquiry-request__session-links-input"
            placeholder="Paste one external session link per line..."
            .value=${live(this.sessionLinksText)}
            @input=${this.handleSessionLinksInput}
          ></textarea>
          <div class="external-inquiry-request__session-links-hint">
            Add the chat URL you used after pasting the answer.
          </div>
        </div>
      </div>
    `;
  }

  private renderKnownSessionLink(link: string): TemplateResult {
    const href = safeHttpUrl(link);
    if (!href) {
      return html`
        <div class="external-inquiry-request__session-link-item">${link}</div>
      `;
    }

    return html`
      <a
        class="external-inquiry-request__session-link-item"
        href=${href}
        target="_blank"
        rel="noopener noreferrer"
        >${link}</a
      >
    `;
  }

  private renderActions(): TemplateResult {
    return html`
      <div class="external-inquiry-request__actions">
        ${renderLabeledActionButton({
          icon: 'check',
          text: 'Submit Answer',
          title: 'Submit the answer from the external model',
          action: INQUIRY_SUBMIT_ACTION,
          disabled: !this.hasAnswer,
          onClick: this.handleSubmit,
        })}
        ${this.renderRejectButton('Reject this external inquiry (n)')}
      </div>
    `;
  }

  // ── Event Handlers ──

  private handleAnswerInput(e: Event): void {
    this.answerText = (e.target as HTMLTextAreaElement).value;
  }

  private handleSessionLinksInput(e: Event): void {
    this.sessionLinksText = (e.target as HTMLTextAreaElement).value;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.handleSubmit();
    }
  }

  private handleSubmit(): void {
    if (!this.hasAnswer) return;
    const answer = this.answerText.trim();
    const sessionLinks = this.normalizedSessionLinks;

    clearInquiryDraft(getRequestId(this.permission));

    this.dispatchEvent(
      ProgressEvents.permissionAction({
        permission: this.permission,
        action: INQUIRY_SUBMIT_ACTION,
        answer,
        sessionLinks: sessionLinks.length ? sessionLinks : undefined,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'external-inquiry-panel': ExternalInquiryPanel;
  }
}
