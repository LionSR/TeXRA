// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register Web Awesome components
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  requestPanelStyles,
} from '@shared/styles';

// Local imports - shared schemas
import type {
  UserQuestionAnswers,
  UserQuestionPermission,
  UserQuestionPrompt,
} from '@shared/schemas';

// Local imports - shared utilities
import { renderLabeledActionButton } from '@shared/wa/actionButtons';

// Local imports - progress view events
import { ProgressEvents } from '../events';

// Local imports - base class
import { BaseFeedbackPanel } from './BaseFeedbackPanel';

@customElement('user-question-panel')
export class UserQuestionPanel extends BaseFeedbackPanel {
  static override styles = [designTokens, commonViewStyles, requestPanelStyles];

  @state() private selections: Record<string, string[]> = {};
  @state() private freeText: Record<string, string> = {};

  override render(): TemplateResult {
    const data = this.permission.data as UserQuestionPermission;

    return html`
      <div class="user-question-request">
        ${data.context
          ? html`<div class="user-question-request__context">
              ${data.context}
            </div>`
          : nothing}
        <div class="user-question-request__questions">
          ${repeat(
            data.questions,
            (question) => question.question,
            (question, index) => this.renderQuestion(question, index),
          )}
        </div>
        <div class="user-question-request__actions">
          ${renderLabeledActionButton({
            icon: 'check',
            text: 'Submit',
            title: 'Submit answers (y)',
            action: 'submit',
            onClick: () => this.submitAnswers(),
          })}
          ${this.renderRejectButton('Reject this question (n)')}
        </div>
        ${this.renderFeedbackSection(
          'user-question-request__feedback',
          'user-question-request__feedback-input',
          'Why are you not answering?',
        )}
      </div>
    `;
  }

  override handleKeyboardShortcut(key: string): boolean {
    if (key === 'y') {
      if (this.showFeedback) return false;
      this.submitAnswers();
      return true;
    }
    return super.handleKeyboardShortcut(key);
  }

  private renderQuestion(
    question: UserQuestionPrompt,
    index: number,
  ): TemplateResult {
    const current = this.selections[question.question] ?? [];
    const inputType = question.multiSelect ? 'checkbox' : 'radio';
    const name = `user-question-${index}`;

    return html`
      <section class="user-question-request__question">
        <div class="user-question-request__heading">
          ${question.header
            ? html`<span class="user-question-request__header">
                ${question.header}
              </span>`
            : nothing}
          <span>${question.question}</span>
        </div>
        <div class="user-question-request__options">
          ${repeat(
            question.options,
            (option) => option.label,
            (option) => html`
              <label class="user-question-request__option">
                <input
                  type=${inputType}
                  name=${name}
                  .checked=${current.includes(option.label)}
                  @change=${(event: Event) =>
                    this.updateSelection(question, option.label, event)}
                />
                <span>
                  <strong>${option.label}</strong>
                  ${option.description
                    ? html`<small>${option.description}</small>`
                    : nothing}
                </span>
              </label>
            `,
          )}
        </div>
        ${question.allowFreeText
          ? html`<wa-textarea
              class="user-question-request__free-text"
              placeholder="Type another answer"
              rows="2"
              .value=${this.freeText[question.question] ?? ''}
              @input=${(event: Event) =>
                this.updateFreeText(question.question, event)}
            ></wa-textarea>`
          : nothing}
      </section>
    `;
  }

  private updateSelection(
    question: UserQuestionPrompt,
    label: string,
    event: Event,
  ): void {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    const current = this.selections[question.question] ?? [];
    const next = question.multiSelect
      ? checked
        ? [...current, label]
        : current.filter((item) => item !== label)
      : checked
        ? [label]
        : [];
    this.selections = { ...this.selections, [question.question]: next };
  }

  private updateFreeText(question: string, event: Event): void {
    const value = ((event.currentTarget as HTMLElement & { value?: string })
      .value ?? '') as string;
    this.freeText = { ...this.freeText, [question]: value };
  }

  private submitAnswers(): void {
    const data = this.permission.data as UserQuestionPermission;
    const answers: UserQuestionAnswers = {};

    for (const question of data.questions) {
      const custom = this.freeText[question.question]?.trim();
      if (custom) {
        answers[question.question] = custom;
        continue;
      }
      const selected = this.selections[question.question] ?? [];
      if (selected.length === 0) continue;
      answers[question.question] = question.multiSelect
        ? selected
        : selected[0];
    }

    this.dispatchEvent(
      ProgressEvents.permissionAction({
        permission: this.permission,
        action: 'submit',
        answers,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'user-question-panel': UserQuestionPanel;
  }
}
