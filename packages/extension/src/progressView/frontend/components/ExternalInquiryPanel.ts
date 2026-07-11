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

import { LRUCache } from 'lru-cache';
import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';

import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type {
  ExternalInquiryPermission,
  InquiryDraft,
  InquiryTranscriptTurn,
} from '@shared/schemas';
import {
  commonViewStyles,
  designTokens,
  requestPanelSharedStyles,
} from '@shared/styles';
import { CopyButtonController } from '@shared/litControllers/CopyButtonController';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';
import { tryParseUrl } from '@utils/core';

import { BaseFeedbackPanel } from './BaseFeedbackPanel';
import { externalInquiryPanelStyles } from './ExternalInquiryPanel.styles';
import { ProgressEvents } from '../events';
import { createBoundedIdSet } from '../utils/boundedIdSet';
import type { PermissionState } from '../permissionState';

// ── Draft persistence ──

const DRAFT_CACHE_CAP = 50;
const DRAFT_SAVE_DELAY_MS = 400;
const draftCache = new LRUCache<string, InquiryDraft>({ max: DRAFT_CACHE_CAP });
const resolvedIds = createBoundedIdSet(DRAFT_CACHE_CAP);
const INQUIRY_SUBMIT_ACTION = 'submit';

interface InquiryPermissionIds {
  requestId: string;
  threadId: string;
}

interface PendingDraftSave extends InquiryPermissionIds {
  draft: InquiryDraft | null;
  timer: ReturnType<typeof setTimeout>;
}

function getRequestId(permission: { data: unknown }): string {
  return (permission.data as ExternalInquiryPermission).requestId;
}

function getThreadId(permission: { data: unknown }): string {
  const data = permission.data as ExternalInquiryPermission;
  return data.threadId ?? data.requestId;
}

function safeHttpUrl(link: string): string | undefined {
  const url = tryParseUrl(link);
  return url && (url.protocol === 'http:' || url.protocol === 'https:')
    ? url.href
    : undefined;
}

function idsEqual(a: InquiryPermissionIds, b: InquiryPermissionIds): boolean {
  return a.requestId === b.requestId && a.threadId === b.threadId;
}

/** Clear draft for a resolved inquiry. Called from eventHandlers on submit/drop. */
export function clearInquiryDraft(requestId: string): void {
  draftCache.delete(requestId);
  resolvedIds.add(requestId);
}

// ── Component ──

@customElement('external-inquiry-panel')
export class ExternalInquiryPanel extends BaseFeedbackPanel<'externalInquiry'> {
  static override styles = [
    designTokens,
    commonViewStyles,
    requestPanelSharedStyles,
    externalInquiryPanelStyles,
  ];

  @state() private answerText = '';
  @state() private sessionLinksText = '';

  private copyController = new CopyButtonController(this);
  private draftRestored = false;
  private pendingDraftSave: PendingDraftSave | undefined;

  // ── Lifecycle ──

  override disconnectedCallback(): void {
    this.flushDraft();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has('permission')) {
      const previousPermission = changed.get('permission') as
        PermissionState | undefined;
      if (previousPermission) this.flushDraft(previousPermission);
      this.answerText = '';
      this.sessionLinksText = '';
      this.draftRestored = false;
    }
    // Restore draft once on first update (avoids the extra render from connectedCallback).
    if (!this.draftRestored) {
      this.draftRestored = true;
      const data = this.permission.data;
      const draft = draftCache.get(getRequestId(this.permission)) ?? data.draft;
      if (draft) {
        this.answerText = draft.answer;
        this.sessionLinksText = draft.sessionLinks;
      }
    }
  }

  private currentDraft(): InquiryDraft | null {
    if (!this.answerText && !this.sessionLinksText) return null;
    return {
      answer: this.answerText,
      sessionLinks: this.sessionLinksText,
    };
  }

  private getPermissionIds(
    permission: { data: unknown } = this.permission,
  ): InquiryPermissionIds {
    return {
      requestId: getRequestId(permission),
      threadId: getThreadId(permission),
    };
  }

  private writeDraft(
    ids: InquiryPermissionIds,
    draft: InquiryDraft | null,
    options: { persist: boolean },
  ): void {
    if (resolvedIds.has(ids.requestId)) return;
    if (draft) {
      draftCache.set(ids.requestId, draft);
    } else {
      draftCache.delete(ids.requestId);
    }
    if (options.persist) {
      postMessage(PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION, {
        action: 'draft',
        threadId: ids.threadId,
        draft,
      });
    }
  }

  private clearPendingDraftSave(): void {
    if (!this.pendingDraftSave) return;
    clearTimeout(this.pendingDraftSave.timer);
    this.pendingDraftSave = undefined;
  }

  private scheduleDraftSave(): void {
    // Read-only trace-viewer export: no live backend for a draft to reach.
    if (this.archived) return;
    const ids = this.getPermissionIds();
    const draft = this.currentDraft();
    this.writeDraft(ids, draft, { persist: false });
    this.clearPendingDraftSave();
    const timer = setTimeout(() => {
      const pending = this.pendingDraftSave;
      this.pendingDraftSave = undefined;
      if (!pending) return;
      if (!idsEqual(this.getPermissionIds(), pending)) return;
      this.writeDraft(pending, pending.draft, { persist: true });
    }, DRAFT_SAVE_DELAY_MS);
    this.pendingDraftSave = { ...ids, draft, timer };
  }

  private flushDraft(permission: { data: unknown } = this.permission): void {
    const ids = this.getPermissionIds(permission);
    const pending = this.pendingDraftSave;
    if (pending && idsEqual(pending, ids)) {
      this.clearPendingDraftSave();
      this.writeDraft(ids, pending.draft, { persist: true });
      return;
    }
    this.writeDraft(ids, this.currentDraft(), { persist: true });
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
    const data = this.permission.data;

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
          ${this.renderTranscript(data.transcript ?? [])}
          ${this.renderQuestion(data.question)}
          ${data.suggestSearch ? this.renderSearchHint() : nothing}
          ${
            data.attachFiles?.length
              ? this.renderAttachFiles(data.attachFiles)
              : nothing
          }
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
      <wa-badge variant="neutral" appearance="filled">
        ${data.mode === 'followUp' ? 'follow-up' : 'new question'}
      </wa-badge>
    `;
  }

  private renderContext(context: string): TemplateResult {
    return html`
      <div class="external-inquiry-request__context">${context}</div>
    `;
  }

  private renderTranscript(
    transcript: InquiryTranscriptTurn[],
  ): TemplateResult | typeof nothing {
    const answeredTurns = transcript.filter((turn) => turn.answer);
    if (answeredTurns.length === 0) return nothing;

    return html`
      <wa-details
        class="external-inquiry-request__transcript"
        appearance="plain"
      >
        <span
          slot="summary"
          class="external-inquiry-request__transcript-summary"
        >
          <wa-icon
            library=${TEXRA_ICON_LIBRARY}
            name="history"
            aria-hidden="true"
          ></wa-icon>
          Conversation transcript (${answeredTurns.length})
        </span>
        <div class="external-inquiry-request__transcript-turns">
          ${repeat(
            answeredTurns,
            (turn) => turn.turnIndex,
            (turn) => this.renderTranscriptTurn(turn),
          )}
        </div>
      </wa-details>
    `;
  }

  private renderTranscriptTurn(turn: InquiryTranscriptTurn): TemplateResult {
    return html`
      <section class="external-inquiry-request__transcript-turn">
        <div class="external-inquiry-request__transcript-turn-header">
          Turn ${turn.turnIndex}
        </div>
        ${
          turn.context
            ? html`
                <div class="external-inquiry-request__transcript-context">
                  ${turn.context}
                </div>
              `
            : nothing
        }
        <div class="external-inquiry-request__transcript-label">Q</div>
        <div class="external-inquiry-request__transcript-text">
          ${turn.question}
        </div>
        <div class="external-inquiry-request__transcript-label">A</div>
        <div class="external-inquiry-request__transcript-text">
          ${turn.answer}
        </div>
        ${
          turn.sessionLinks?.length
            ? html`
                <div class="external-inquiry-request__transcript-links">
                  ${turn.sessionLinks.map((link) =>
                    this.renderKnownSessionLink(link),
                  )}
                </div>
              `
            : nothing
        }
      </section>
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
        <wa-icon
          library=${TEXRA_ICON_LIBRARY}
          name="lightbulb"
          aria-hidden="true"
        ></wa-icon>
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
            library=${TEXRA_ICON_LIBRARY}
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
                  library=${TEXRA_ICON_LIBRARY}
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
        <wa-textarea
          class="external-inquiry-request__answer-input"
          placeholder="Paste the answer here..."
          rows="4"
          resize="vertical"
          .value=${live(this.answerText)}
          @input=${this.handleAnswerInput}
          @keydown=${this.handleKeyDown}
        ></wa-textarea>
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
        ${
          sessionLinks.length
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
            : nothing
        }
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
          <wa-textarea
            class="external-inquiry-request__session-links-input"
            placeholder="Paste one external session link per line..."
            rows="2"
            resize="vertical"
            .value=${live(this.sessionLinksText)}
            @input=${this.handleSessionLinksInput}
          ></wa-textarea>
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
    this.answerText =
      (e.target as HTMLElement & { value?: string }).value ?? '';
    this.scheduleDraftSave();
  }

  private handleSessionLinksInput(e: Event): void {
    this.sessionLinksText =
      (e.target as HTMLElement & { value?: string }).value ?? '';
    this.scheduleDraftSave();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.handleSubmit();
    }
  }

  private handleSubmit(): void {
    // Bypasses the base class's emitAction chokepoint (dispatches
    // permission-action directly), so the archived/read-only trace-viewer
    // guard has to be repeated here.
    if (this.archived) return;
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
