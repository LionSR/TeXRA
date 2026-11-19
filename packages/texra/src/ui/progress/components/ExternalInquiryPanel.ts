/**
 * External inquiry card: "Ask an outside model", then question (with Copy
 * and links to the chat apps) → answer → Submit. Context, earlier turns and
 * session links wait in one "More" disclosure.
 *
 * Skipping sends no note: a declined inquiry is recorded as dropped and the
 * agent is told only that, so a note box here would collect words nobody
 * reads.
 *
 * The answer draft lives in the surface's `requestDrafts` under the
 * inquiry's turn, so it survives a re-mount.
 */

import { Schema } from 'effect';
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';

import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import WaTextarea from '@awesome.me/webawesome/dist/components/textarea/textarea.js';

import {
  InquiryRequestSchema,
  type AnsweredInquiryTurn,
  type InquiryDraft,
  type InquiryRequest,
} from '@texra/shared/plugins/externalInquiry';
import { CopyButtonController } from '@ui/litControllers/CopyButtonController';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { isSendChord } from '@ui/wa/keyActivation';
import { renderDotMeta } from '@ui/wa/metaStrip';
import { waIcon } from '@ui/wa/webAwesomeIcons';

import { BaseRequestPanel } from './BaseRequestPanel';
import { externalInquiryPanelStyles } from './ExternalInquiryPanel.styles';

/** The chats the panel links: the ones the External Inquiry plugin card
 *  names. The question is pasted by hand, so any other chat works too. */
const INQUIRY_CHATS = [
  ['ChatGPT', 'https://chatgpt.com/'],
  ['Claude', 'https://claude.ai/new'],
  ['Gemini', 'https://gemini.google.com/app'],
  ['Grok', 'https://grok.com/'],
] as const;

const EMPTY_DRAFT: InquiryDraft = Object.freeze({
  answer: '',
  sessionLinks: '',
});

/** The distinct session links the earlier answers cite, most recent first,
 *  so the person can continue the same outside conversation. */
function knownSessionLinks(turns: readonly AnsweredInquiryTurn[]): string[] {
  return [...new Set(turns.toReversed().flatMap((turn) => turn.sessionLinks))];
}

interface ValidatableTextarea extends HTMLElement {
  setCustomValidity(message: string): void;
  reportValidity(): boolean;
}

function safeHttpUrl(link: string): string | undefined {
  const url = URL.parse(link);
  return url && (url.protocol === 'http:' || url.protocol === 'https:')
    ? url.href
    : undefined;
}

@customElement('external-inquiry-panel')
export class ExternalInquiryPanel extends BaseRequestPanel<'plugin'> {
  static override styles = [
    BaseRequestPanel.styles,
    externalInquiryPanelStyles,
  ];

  /** The last decoded request data and the inquiry it holds. */
  private decoded: { data: unknown; inquiry: InquiryRequest } | undefined;
  private copyController = new CopyButtonController(this);

  /** The inquiry the request holds, decoded once per request. */
  private get inquiry(): InquiryRequest {
    const { data } = this.permission;
    if (this.decoded?.data !== data) {
      this.decoded = {
        data,
        inquiry: Schema.decodeUnknownSync(InquiryRequestSchema)(data),
      };
    }
    return this.decoded.inquiry;
  }

  /** An answer is kept per inquiry turn, never per request or run: the
   *  thread and the turn the request opens. */
  protected override get draftKey(): string {
    const { threadId, turn } = this.inquiry;
    return `${threadId}#${turn.turnIndex}`;
  }

  /** The answer in progress, as the surface holds it. */
  private get answer(): InquiryDraft {
    return this.draft.inquiry ?? EMPTY_DRAFT;
  }

  /** Store one field's edit; a draft with both fields empty is none. */
  private editDraft(patch: Partial<InquiryDraft>): void {
    const next = { ...this.answer, ...patch };
    const { inquiry: _previous, ...rest } = this.draft;
    this.writeDraft(
      next.answer || next.sessionLinks ? { ...rest, inquiry: next } : rest,
    );
  }

  // ── Render ──

  private get hasAnswer(): boolean {
    return this.answer.answer.trim().length > 0;
  }

  private get normalizedSessionLinks(): string[] {
    return [
      ...new Set(
        this.answer.sessionLinks
          .split('\n')
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    ];
  }

  protected override get declineTakesNote(): boolean {
    return false;
  }

  protected override submitPrimary(): void {
    this.handleSubmit();
  }

  protected override renderAsk(): string {
    return this.inquiry.turn.turnIndex > 1
      ? 'Ask an outside model a follow-up'
      : 'Ask an outside model';
  }

  override render(): TemplateResult {
    const { turn } = this.inquiry;
    return this.renderCard(html`
      ${this.renderQuestion(turn.question)}
      ${turn.suggestSearch ? this.renderSearchHint() : nothing}
      ${
        turn.attachFiles.length > 0
          ? this.renderAttachFiles(turn.attachFiles)
          : nothing
      }
      ${this.renderAnswerArea()} ${this.renderMore(this.inquiry)}
    `);
  }

  /** Everything the answer does not need: context, earlier turns, links. */
  private renderMore({ turn, earlierTurns }: InquiryRequest): TemplateResult {
    return html`
      <wa-details class="external-inquiry-request__more" summary="More">
        ${
          turn.context
            ? html`<div class="request-card__context">${turn.context}</div>`
            : nothing
        }
        ${this.renderTranscript(earlierTurns)}
        ${this.renderSessionLinks(knownSessionLinks(earlierTurns))}
      </wa-details>
    `;
  }

  private renderTranscript(
    answeredTurns: readonly AnsweredInquiryTurn[],
  ): TemplateResult | typeof nothing {
    if (answeredTurns.length === 0) return nothing;

    return html`
      <div class="external-inquiry-request__transcript-turns">
        ${repeat(
          answeredTurns,
          (turn) => turn.turnIndex,
          (turn) => this.renderTranscriptTurn(turn),
        )}
      </div>
    `;
  }

  private renderTranscriptTurn(turn: AnsweredInquiryTurn): TemplateResult {
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
          turn.sessionLinks.length > 0
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
    const { copied } = this.copyController;

    return html`
      <div class="external-inquiry-request__question">
        <div class="external-inquiry-request__question-text">${question}</div>
        <div class="external-inquiry-request__question-actions">
          ${renderLabeledActionButton({
            icon: copied ? 'check' : 'copy',
            text: copied ? 'Question copied' : 'Copy question',
            title: 'Copy the question to paste into another model',
            onClick: () => this.copyController.copy(question),
          })}
          <span class="external-inquiry-request__chat-links">
            Paste it into
            ${renderDotMeta(
              INQUIRY_CHATS.map(
                ([name, url]) =>
                  html`<a
                    class="clickable-link"
                    href=${url}
                    target="_blank"
                    rel="noopener noreferrer"
                    >${name}</a
                  >`,
              ),
            )}
          </span>
        </div>
      </div>
    `;
  }

  private renderSearchHint(): TemplateResult {
    return html`
      <div class="external-inquiry-request__search-hint">
        ${waIcon('lightbulb')} Turn on <strong>search</strong> in that chat for
        this question.
      </div>
    `;
  }

  private renderAttachFiles(files: readonly string[]): TemplateResult {
    return html`
      <div class="external-inquiry-request__attach-files">
        <div class="external-inquiry-request__attach-label">
          ${waIcon('cloud-arrow-up')} Upload these files with the question:
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
          .value=${live(this.answer.answer)}
          @input=${this.handleAnswerInput}
          @keydown=${this.handleKeyDown}
        >
          <span slot="label" class="external-inquiry-request__answer-label">
            Answer
          </span>
          <span slot="hint" class="external-inquiry-request__answer-hint">
            If the answer comes with files, save them in the workspace and name
            their paths here.
          </span>
        </wa-textarea>
      </div>
    `;
  }

  private renderSessionLinks(sessionLinks: readonly string[]): TemplateResult {
    return html`
      ${
        sessionLinks.length
          ? html`
              <ul class="external-inquiry-request__session-links-list">
                ${repeat(
                  sessionLinks,
                  (link) => link,
                  (link) => html`<li>${this.renderKnownSessionLink(link)}</li>`,
                )}
              </ul>
            `
          : nothing
      }
      <wa-textarea
        class="external-inquiry-request__session-links-input"
        name="external-inquiry-session-links"
        placeholder="One chat URL per line…"
        rows="2"
        resize="vertical"
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        inputmode="url"
        .value=${live(this.answer.sessionLinks)}
        @input=${this.handleSessionLinksInput}
      >
        <span
          slot="label"
          class="external-inquiry-request__session-links-label"
        >
          Chat links to keep for follow-ups
        </span>
      </wa-textarea>
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
        class="external-inquiry-request__session-link-item clickable-link"
        href=${href}
        target="_blank"
        rel="noopener noreferrer"
        >${link}</a
      >
    `;
  }

  // ── Event Handlers ──

  private handleAnswerInput(e: Event): void {
    if (!(e.currentTarget instanceof WaTextarea)) return;
    e.currentTarget.setCustomValidity('');
    this.editDraft({ answer: e.currentTarget.value ?? '' });
  }

  private handleSessionLinksInput(e: Event): void {
    if (!(e.currentTarget instanceof WaTextarea)) return;
    e.currentTarget.setCustomValidity('');
    this.editDraft({ sessionLinks: e.currentTarget.value ?? '' });
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!isSendChord(e)) return;
    e.preventDefault();
    this.handleSubmit();
  }

  private handleSubmit(): void {
    const answerInput = this.renderRoot.querySelector<ValidatableTextarea>(
      '.external-inquiry-request__answer-input',
    );
    const hasAnswer = this.hasAnswer;
    answerInput?.setCustomValidity(
      hasAnswer ? '' : 'Paste the external model’s answer before submitting.',
    );
    if (!hasAnswer) {
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
      // The links box sits in the collapsed "More": open it so the message
      // shows where the bad link is.
      const more = this.renderRoot.querySelector<
        HTMLElement & { open: boolean }
      >('.external-inquiry-request__more');
      if (more) more.open = true;
      void this.updateComplete.then(() => sessionLinksInput?.reportValidity());
      return;
    }

    const answer = this.answer.answer.trim();

    this.emitAction({
      action: 'answer',
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
