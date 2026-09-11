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

  // Indexed by question position (not `question.question`): two questions
  // with identical wording would otherwise collide on a text key, both in
  // Lit's `repeat` reconciliation and in these state maps.
  @state() private selections: string[][] = [];
  @state() private freeText: string[] = [];

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
            (_question, index) => index,
            (question, index) => this.renderQuestion(question, index),
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
            disabled: this.readOnly,
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

  private renderQuestion(
    question: UserQuestionPrompt,
    index: number,
  ): TemplateResult {
    const current = this.selections[index] ?? [];

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
                  (option) => this.renderCheckboxOption(index, option, current),
                )
              : html`
                  <wa-radio-group
                    label="Choose one answer"
                    .value=${
                      this.freeText[index]?.trim() ? '' : (current[0] ?? '')
                    }
                    @change=${(event: Event) =>
                      this.updateSingleSelection(index, event)}
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
                .value=${this.freeText[index] ?? ''}
                @input=${(event: Event) => this.updateFreeText(index, event)}
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
    index: number,
    option: UserQuestionPrompt['options'][number],
    current: string[],
  ): TemplateResult {
    return html`
      <wa-checkbox
        class="user-question-request__option"
        ?checked=${current.includes(option.label)}
        @change=${(event: Event) =>
          this.updateSelection(index, option.label, event)}
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

  private updateSelection(index: number, label: string, event: Event): void {
    const checked = (event.target as HTMLElement & { checked?: boolean })
      .checked;
    const current = this.selections[index] ?? [];
    const next = checked
      ? [...current, label]
      : current.filter((item) => item !== label);
    const nextSelections = [...this.selections];
    nextSelections[index] = next;
    this.selections = nextSelections;
  }

  private updateSingleSelection(index: number, event: Event): void {
    const value =
      (event.target as HTMLElement & { value?: string }).value ?? '';
    const nextSelections = [...this.selections];
    nextSelections[index] = value ? [value] : [];
    this.selections = nextSelections;
    if (value && this.freeText[index]) {
      const nextFreeText = [...this.freeText];
      nextFreeText[index] = '';
      this.freeText = nextFreeText;
    }
  }

  private updateFreeText(index: number, event: Event): void {
    const value =
      (event.currentTarget as HTMLElement & { value?: string }).value ?? '';
    const nextFreeText = [...this.freeText];
    nextFreeText[index] = value;
    this.freeText = nextFreeText;
  }

  private submitAnswers(): void {
    if (this.readOnly) return;
    const data = this.permission.data;
    if (!this.hasAnyAnswer(data)) {
      this.renderRoot
        .querySelector<HTMLElement>('wa-radio-group, wa-checkbox, wa-textarea')
        ?.focus();
      return;
    }
    const answers: UserQuestionAnswers = {};

    data.questions.forEach((question, index) => {
      const custom = this.freeText[index]?.trim();
      const selected = this.selections[index] ?? [];
      if (question.multiSelect) {
        // The box is labelled "Another answer", so on a multi-select
        // question it adds to the checked options instead of replacing them.
        const merged = custom ? [...selected, custom] : selected;
        const answer = [...new Set(merged)];
        if (answer.length === 0) return;
        answers[question.question] = answer;
        return;
      }
      // Single-select holds one answer, so free text stays an override — it is
      // the escape hatch for "none of these options fit".
      if (custom) {
        answers[question.question] = custom;
        return;
      }
      if (selected.length === 0) return;
      answers[question.question] = selected[0];
    });

    this.emitAction({ action: 'submit', answers });
  }

  private hasAnyAnswer(data: UserQuestionPermission): boolean {
    return data.questions.some((_question, index) => {
      if (this.freeText[index]?.trim()) return true;
      return (this.selections[index] ?? []).length > 0;
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'user-question-panel': UserQuestionPanel;
  }
}
