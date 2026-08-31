// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register Web Awesome components
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import '@awesome.me/webawesome/dist/components/radio/radio.js';
import '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  requestPanelSharedStyles,
} from '@shared/styles';

// Local imports - shared schemas
import type {
  UserQuestionAnswers,
  UserQuestionPermission,
  UserQuestionPrompt,
} from '@shared/schemas';

// Local imports - shared utilities
import { renderLabeledActionButton } from '@shared/wa/actionButtons';

// Local imports - base class
import {
  BaseFeedbackPanel,
  REDIRECT_FEEDBACK_PROMPT,
} from './BaseFeedbackPanel';

// Local imports - styles
import { userQuestionPanelStyles } from './UserQuestionPanel.styles';

@customElement('user-question-panel')
export class UserQuestionPanel extends BaseFeedbackPanel<'userQuestion'> {
  static override styles = [
    designTokens,
    commonViewStyles,
    requestPanelSharedStyles,
    userQuestionPanelStyles,
  ];

  @state() private selections: Record<string, string[]> = {};
  @state() private freeText: Record<string, string> = {};

  override render(): TemplateResult {
    const data = this.permission.data;
    const canSubmit = this.hasAnyAnswer(data);

    return html`
      <div class="user-question-request">
        ${
          data.context
            ? html`<div class="user-question-request__context">
                ${data.context}
              </div>`
            : nothing
        }
        <div class="user-question-request__questions">
          ${repeat(
            data.questions,
            (question) => question.question,
            (question) => this.renderQuestion(question),
          )}
        </div>
        <div class="user-question-request__actions">
          ${renderLabeledActionButton({
            icon: 'check',
            text: 'Submit answers',
            title: canSubmit
              ? 'Submit answers (y)'
              : 'Select or type at least one answer before submitting',
            action: 'submit',
            kind: 'primary',
            disabled: this.archived,
            onClick: () => this.submitAnswers(),
          })}
          ${this.renderRejectButton('Reject this question (n)')}
        </div>
        <p class="user-question-request__answer-requirement" role="status">
          ${canSubmit ? '' : 'Answer at least one question to continue.'}
        </p>
        ${this.renderFeedbackSection(
          'user-question-request__feedback',
          'user-question-request__feedback-input',
          REDIRECT_FEEDBACK_PROMPT,
        )}
      </div>
    `;
  }

  override handleKeyboardShortcut(key: string): boolean {
    if (key !== 'y') return super.handleKeyboardShortcut(key);
    if (this.showFeedback) return false;
    this.submitAnswers();
    return true;
  }

  private renderQuestion(question: UserQuestionPrompt): TemplateResult {
    const current = this.selections[question.question] ?? [];

    return html`
      <fieldset class="user-question-request__question">
        <legend class="user-question-request__heading">
          <span class="user-question-request__heading-content">
            ${
              question.header
                ? html`<span class="user-question-request__header">
                    ${question.header}
                  </span>`
                : nothing
            }
            <span>${question.question}</span>
          </span>
        </legend>
        <div class="user-question-request__options">
          ${
            question.multiSelect
              ? repeat(
                  question.options,
                  (option) => option.label,
                  (option) =>
                    this.renderCheckboxOption(question, option, current),
                )
              : html`
                  <wa-radio-group
                    label="Choose one answer"
                    .value=${
                      this.freeText[question.question]?.trim()
                        ? ''
                        : (current[0] ?? '')
                    }
                    @change=${(event: Event) =>
                      this.updateSingleSelection(question, event)}
                  >
                    ${repeat(
                      question.options,
                      (option) => option.label,
                      (option) => this.renderRadioOption(option),
                    )}
                  </wa-radio-group>
                `
          }
        </div>
        ${
          question.allowFreeText
            ? html`<wa-textarea
                class="user-question-request__free-text"
                label="Another answer"
                hint=${
                  question.multiSelect
                    ? 'Adds to the selected options.'
                    : 'Replaces the selected option.'
                }
                rows="2"
                resize="vertical"
                autocomplete="off"
                spellcheck
                .value=${this.freeText[question.question] ?? ''}
                @input=${(event: Event) => this.updateFreeText(question, event)}
              ></wa-textarea>`
            : nothing
        }
      </fieldset>
    `;
  }

  private renderOptionLabel(
    option: UserQuestionPrompt['options'][number],
  ): TemplateResult {
    return html`
      <strong>${option.label}</strong>
      ${
        option.description
          ? html`<small>${option.description}</small>`
          : nothing
      }
    `;
  }

  private renderCheckboxOption(
    question: UserQuestionPrompt,
    option: UserQuestionPrompt['options'][number],
    current: string[],
  ): TemplateResult {
    return html`
      <wa-checkbox
        class="user-question-request__option"
        ?checked=${current.includes(option.label)}
        @change=${(event: Event) =>
          this.updateSelection(question, option.label, event)}
      >
        ${this.renderOptionLabel(option)}
      </wa-checkbox>
    `;
  }

  private renderRadioOption(
    option: UserQuestionPrompt['options'][number],
  ): TemplateResult {
    return html`
      <wa-radio class="user-question-request__option" value=${option.label}>
        ${this.renderOptionLabel(option)}
      </wa-radio>
    `;
  }

  private updateSelection(
    question: UserQuestionPrompt,
    label: string,
    event: Event,
  ): void {
    const checked = (event.target as HTMLElement & { checked?: boolean })
      .checked;
    const current = this.selections[question.question] ?? [];
    const next = checked
      ? [...current, label]
      : current.filter((item) => item !== label);
    this.selections = { ...this.selections, [question.question]: next };
  }

  private updateSingleSelection(
    question: UserQuestionPrompt,
    event: Event,
  ): void {
    const value =
      (event.target as HTMLElement & { value?: string }).value ?? '';
    this.selections = {
      ...this.selections,
      [question.question]: value ? [value] : [],
    };
    if (value && this.freeText[question.question]) {
      this.freeText = { ...this.freeText, [question.question]: '' };
    }
  }

  private updateFreeText(question: UserQuestionPrompt, event: Event): void {
    const value =
      (event.currentTarget as HTMLElement & { value?: string }).value ?? '';
    this.freeText = { ...this.freeText, [question.question]: value };
  }

  private submitAnswers(): void {
    if (this.archived) return;
    const data = this.permission.data;
    if (!this.hasAnyAnswer(data)) {
      this.renderRoot
        .querySelector<HTMLElement>('wa-radio-group, wa-checkbox, wa-textarea')
        ?.focus();
      return;
    }
    const answers: UserQuestionAnswers = {};

    for (const question of data.questions) {
      const custom = this.freeText[question.question]?.trim();
      const selected = this.selections[question.question] ?? [];
      if (question.multiSelect) {
        // The box is labelled "Another answer", so on a multi-select
        // question it adds to the checked options instead of replacing them.
        const merged = custom ? [...selected, custom] : selected;
        const answer = [...new Set(merged)];
        if (answer.length === 0) continue;
        answers[question.question] = answer;
        continue;
      }
      // Single-select holds one answer, so free text stays an override — it is
      // the escape hatch for "none of these options fit".
      if (custom) {
        answers[question.question] = custom;
        continue;
      }
      if (selected.length === 0) continue;
      answers[question.question] = selected[0];
    }

    this.emitAction({ action: 'submit', answers });
  }

  private hasAnyAnswer(data: UserQuestionPermission): boolean {
    return data.questions.some((question) => {
      if (this.freeText[question.question]?.trim()) return true;
      return (this.selections[question.question] ?? []).length > 0;
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'user-question-panel': UserQuestionPanel;
  }
}
