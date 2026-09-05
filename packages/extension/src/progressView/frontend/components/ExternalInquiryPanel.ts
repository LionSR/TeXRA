/**
 * UI panel for external inquiry requests.
 *
 * Displays a question formulated by the agent, with a "Copy question" button
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

import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type {
  ExternalInquiryPermission,
  InquiryDraft,
  PermissionPayload,
  InquiryTranscriptTurn,
} from '@shared/schemas';
import {
  commonViewStyles,
  designTokens,
  requestPanelSharedStyles,
} from '@shared/styles';
import { CopyButtonController } from '@shared/litControllers/CopyButtonController';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderDotMeta } from '@shared/wa/metaStrip';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { createFlushableDebounce, tryParseUrl } from '@utils/core';

import {
  clearInquiryDraft,
  getInquiryDraft,
  isInquiryDraftResolved,
  setInquiryDraft,
} from '../slices/inquiryDraftState';
import {
  BaseFeedbackPanel,
  REDIRECT_FEEDBACK_PROMPT,
} from './BaseFeedbackPanel';
import { externalInquiryPanelStyles } from './ExternalInquiryPanel.styles';

type ExternalInquiryPermissionState = Extract<
  PermissionPayload,
  { kind: typeof PERMISSION_KIND.EXTERNAL_INQUIRY }
>;

// ── Draft persistence ──

const DRAFT_SAVE_DELAY_MS = 400;
const INQUIRY_SUBMIT_ACTION = 'submit';

interface InquiryPermissionIds {
  requestId: string;
  threadId: string;
}

interface PendingDraftSave extends InquiryPermissionIds {
  draft: InquiryDraft | null;
}

interface ValidatableTextarea extends HTMLElement {
  setCustomValidity(message: string): void;
  reportValidity(): boolean;
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
  private readonly draftSaveDebounce = createFlushableDebounce(() => {
    const pending = this.pendingDraftSave;
    this.pendingDraftSave = undefined;
    if (!pending) return;
    if (!idsEqual(this.getPermissionIds(), pending)) return;
    this.writeDraft(pending, pending.draft, { persist: true });
  }, DRAFT_SAVE_DELAY_MS);

  // ── Lifecycle ──

  override disconnectedCallback(): void {
    this.flushDraft();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has('permission')) {
      const previousPermission = changed.get('permission') as
        ExternalInquiryPermissionState | undefined;
      if (previousPermission) this.flushDraft(previousPermission);
      this.answerText = '';
      this.sessionLinksText = '';
      this.draftRestored = false;
    }
    // Restore draft once on first update (avoids the extra render from connectedCallback).
    if (!this.draftRestored) {
      this.draftRestored = true;
      const data = this.permission.data;
      const draft = getInquiryDraft(data.requestId) ?? data.draft;
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
    permission: ExternalInquiryPermissionState = this.permission,
  ): InquiryPermissionIds {
    const { data } = permission;
    return {
      requestId: data.requestId,
      threadId: data.threadId ?? data.requestId,
    };
  }

  private writeDraft(
    ids: InquiryPermissionIds,
    draft: InquiryDraft | null,
    options: { persist: boolean },
  ): void {
    if (isInquiryDraftResolved(ids.requestId)) return;
    setInquiryDraft(ids.requestId, draft);
    if (options.persist) {
      postMessage(PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION, {
        action: 'draft',
        threadId: ids.threadId,
        draft,
      });
    }
  }

  private scheduleDraftSave(): void {
    // Read-only trace-viewer export: no live backend for a draft to reach.
    if (this.readOnly) return;
    const ids = this.getPermissionIds();
    const draft = this.currentDraft();
    this.writeDraft(ids, draft, { persist: false });
    this.pendingDraftSave = { ...ids, draft };
    this.draftSaveDebounce.schedule();
  }

  private flushDraft(
    permission: ExternalInquiryPermissionState = this.permission,
  ): void {
    const ids = this.getPermissionIds(permission);
    const pending = this.pendingDraftSave;
    if (pending && idsEqual(pending, ids)) {
      if (idsEqual(this.getPermissionIds(), ids)) {
        this.draftSaveDebounce.flush();
        return;
      }

      // During a permission replacement, Lit has already assigned the new
      // permission. Cancel the timer and persist the saved old draft directly.
      this.draftSaveDebounce.cancel();
      this.pendingDraftSave = undefined;
      this.writeDraft(ids, pending.draft, { persist: true });
      return;
    }
    this.writeDraft(ids, this.currentDraft(), { persist: true });
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
            REDIRECT_FEEDBACK_PROMPT,
          )}
        </div>
        ${this.renderActions()}
      </div>
    `;
  }

  private renderHeader(data: ExternalInquiryPermission): TemplateResult {
    return html`
      <wa-badge variant="neutral" appearance="filled">
        ${(data.transcript?.length ?? 0) > 1 ? 'follow-up' : 'new question'}
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
          ${waIcon('clock-rotate-left')} Conversation transcript
          (${answeredTurns.length})
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
        <div class="external-inquiry-request__transcript-label">Question</div>
        <div class="external-inquiry-request__transcript-text">
          ${turn.question}
        </div>
        <div class="external-inquiry-request__transcript-label">Answer</div>
        <div class="external-inquiry-request__transcript-text">
          ${turn.answer}
        </div>
        ${
          turn.sessionLinks?.length
            ? html`
                <ul class="external-inquiry-request__transcript-links">
                  ${turn.sessionLinks.map(
                    (link) =>
                      html`<li>${this.renderKnownSessionLink(link)}</li>`,
                  )}
                </ul>
              `
            : nothing
        }
      </section>
    `;
  }

  private renderQuestion(question: string): TemplateResult {
    const { copied } = this.copyController.state;
    const text = copied ? 'Question copied' : 'Copy question';

    return html`
      <div class="external-inquiry-request__question">
        <div class="external-inquiry-request__question-text">${question}</div>
        <div class="external-inquiry-request__question-actions">
          ${renderLabeledActionButton({
            icon: copied ? 'check' : 'copy',
            text,
            title: copied
              ? 'Question copied to clipboard'
              : 'Copy question to clipboard for pasting into an external AI model',
            onClick: () => this.copyController.copy(question),
          })}
        </div>
      </div>
    `;
  }

  private renderSearchHint(): TemplateResult {
    return html`
      <div class="external-inquiry-request__search-hint">
        ${waIcon('lightbulb')} Consider enabling <strong>Search</strong> mode in
        the external tool for this question
      </div>
    `;
  }

  private renderAttachFiles(files: string[]): TemplateResult {
    return html`
      <div class="external-inquiry-request__attach-files">
        <div class="external-inquiry-request__attach-label">
          ${waIcon('cloud-arrow-up')} Files to upload to the external model:
        </div>
        <ul class="external-inquiry-request__file-list">
          ${files.map(
            (file) => html`
              <li class="external-inquiry-request__file-item">
                ${waIcon('file')}
                <span>${file}</span>
              </li>
            `,
          )}
        </ul>
      </div>
    `;
  }

  private renderAnswerArea(): TemplateResult {
    return html`
      <div class="external-inquiry-request__answer-area">
        <wa-textarea
          class="external-inquiry-request__answer-input"
          name="external-inquiry-answer"
          placeholder="Paste the answer here…"
          rows="4"
          resize="vertical"
          required
          autocomplete="off"
          spellcheck="true"
          .value=${live(this.answerText)}
          @input=${this.handleAnswerInput}
          @keydown=${this.handleKeyDown}
        >
          <span slot="label" class="external-inquiry-request__answer-label">
            Paste the answer from the external model
          </span>
          <span slot="hint" class="external-inquiry-request__answer-hint">
            If the external model returns files, save them into the workspace
            and tell the agent the paths.
          </span>
        </wa-textarea>
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
                  <ul class="external-inquiry-request__session-links-list">
                    ${repeat(
                      sessionLinks,
                      (link) => link,
                      (link) =>
                        html`<li>${this.renderKnownSessionLink(link)}</li>`,
                    )}
                  </ul>
                </div>
              `
            : nothing
        }
        <div class="external-inquiry-request__session-links-input-group">
          <div class="external-inquiry-request__chat-links">
            Open:
            ${renderDotMeta([
              html`<a
                href="https://chatgpt.com/plans/pro/"
                target="_blank"
                rel="noopener noreferrer"
                >ChatGPT Pro</a
              >`,
              html`<a
                href="https://deepmind.google/models/gemini/deep-think/"
                target="_blank"
                rel="noopener noreferrer"
                >Gemini Deep Think</a
              >`,
            ])}
          </div>
          <wa-textarea
            class="external-inquiry-request__session-links-input"
            name="external-inquiry-session-links"
            placeholder="Paste one external session link per line…"
            rows="2"
            resize="vertical"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            inputmode="url"
            .value=${live(this.sessionLinksText)}
            @input=${this.handleSessionLinksInput}
          >
            <span
              slot="label"
              class="external-inquiry-request__session-links-label"
            >
              Save external session links for follow-ups
            </span>
            <span
              slot="hint"
              class="external-inquiry-request__session-links-hint"
            >
              Add the chat URLs you used, one per line.
            </span>
          </wa-textarea>
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
          text: 'Submit answer',
          title: 'Submit the answer from the external model',
          action: INQUIRY_SUBMIT_ACTION,
          kind: 'primary',
          disabled: this.readOnly,
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
    (e.currentTarget as ValidatableTextarea).setCustomValidity('');
    this.scheduleDraftSave();
  }

  private handleSessionLinksInput(e: Event): void {
    this.sessionLinksText =
      (e.target as HTMLElement & { value?: string }).value ?? '';
    (e.currentTarget as ValidatableTextarea).setCustomValidity('');
    this.scheduleDraftSave();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.handleSubmit();
    }
  }

  private handleSubmit(): void {
    if (this.readOnly) return;
    const answerInput = this.renderRoot.querySelector<ValidatableTextarea>(
      '.external-inquiry-request__answer-input',
    );
    answerInput?.setCustomValidity(
      this.hasAnswer
        ? ''
        : 'Paste the external model’s answer before submitting.',
    );
    if (!this.hasAnswer) {
      answerInput?.reportValidity();
      return;
    }

    const sessionLinks = this.normalizedSessionLinks;
    const sessionLinksInput =
      this.renderRoot.querySelector<ValidatableTextarea>(
        '.external-inquiry-request__session-links-input',
      );
    const hasInvalidSessionLink = sessionLinks.some(
      (link) => safeHttpUrl(link) === undefined,
    );
    sessionLinksInput?.setCustomValidity(
      hasInvalidSessionLink
        ? 'Enter complete http:// or https:// URLs, one per line.'
        : '',
    );
    if (hasInvalidSessionLink) {
      sessionLinksInput?.reportValidity();
      return;
    }

    const answer = this.answerText.trim();

    clearInquiryDraft(this.permission.data.requestId);

    this.emitAction({
      action: INQUIRY_SUBMIT_ACTION,
      answer,
      ...(sessionLinks.length ? { sessionLinks } : {}),
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'external-inquiry-panel': ExternalInquiryPanel;
  }
}
