/** User question card: "Answer 2 questions", the questions, Submit / Skip. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register Web Awesome components
import WaCheckbox from '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import '@awesome.me/webawesome/dist/components/radio/radio.js';
import WaRadioGroup from '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';
import WaTextarea from '@awesome.me/webawesome/dist/components/textarea/textarea.js';

// Local imports - shared styles

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

// Local imports - styles
import { userQuestionPanelStyles } from './UserQuestionPanel.styles';
import type {
  UserQuestionAnswers,
  UserQuestionRequest,
  UserQuestionPrompt,
} from '@texra-ai/harness/schemas';

@customElement('user-question-panel')
export class UserQuestionPanel extends BaseRequestPanel<'userQuestion'> {
  static override styles = [BaseRequestPanel.styles, userQuestionPanelStyles];

  /** Question `index`'s picks and typed answer, from the card's draft
   *  (by position: Lit's `repeat` keys the questions by it too). */
  private answerAt(index: number): {
    selected: readonly string[];
    text: string;
  } {
    return this.draft.answers?.[index] ?? { selected: [], text: '' };
  }

  /** Change question `index`'s answer in the draft. */
  private editAnswer(
    index: number,
    patch: Partial<{ selected: readonly string[]; text: string }>,
  ): void {
    const { questions } = this.permission.data;
    const answers = questions.map((_question, at) => {
      const answer = this.answerAt(at);
      return at === index
        ? {
            selected: [...(patch.selected ?? answer.selected)],
            text: patch.text ?? answer.text,
          }
        : { selected: [...answer.selected], text: answer.text };
    });
    this.writeDraft({ ...this.draft, answers });
  }

  protected override get notePrompt(): string {
    return 'What should the agent do instead?';
  }

  protected override submitPrimary(): void {
    this.submitAnswers();
  }

  protected override renderAsk(): string {
    const count = this.permission.data.questions.length;
    return count === 1 ? 'Answer a question' : `Answer ${count} questions`;
  }

  override render(): TemplateResult {
    const data = this.permission.data;
    const canSubmit = this.hasAnyAnswer(data);

    return this.renderCard(html`
      ${
        data.context
          ? html`<div class="request-card__context">${data.context}</div>`
          : nothing
      }
      <div class="user-question-request__questions">
        ${repeat(
          data.questions,
          (_question, index) => index,
          (question, index) => this.renderQuestion(question, index),
        )}
      </div>
      <p class="user-question-request__answer-requirement" role="status">
        ${canSubmit ? '' : 'Answer at least one question to continue.'}
      </p>
    `);
  }

  private renderQuestion(
    question: UserQuestionPrompt,
    index: number,
  ): TemplateResult {
    const current = this.answerAt(index).selected;

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
                      this.answerAt(index).text.trim() ? '' : (current[0] ?? '')
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
                .value=${live(this.answerAt(index).text)}
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
    current: readonly string[],
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
    if (!(event.target instanceof WaCheckbox)) return;
    const { checked } = event.target;
    const current = this.answerAt(index).selected;
    this.editAnswer(index, {
      selected: checked
        ? [...current, label]
        : current.filter((item) => item !== label),
    });
  }

  private updateSingleSelection(index: number, event: Event): void {
    if (!(event.target instanceof WaRadioGroup)) return;
    // Each radio's value is its option label, a string.
    const { value } = event.target;
    const label = typeof value === 'string' ? value : '';
    // Picking an option replaces a typed single answer.
    this.editAnswer(index, {
      selected: label ? [label] : [],
      ...(label && { text: '' }),
    });
  }

  private updateFreeText(index: number, event: Event): void {
    if (!(event.currentTarget instanceof WaTextarea)) return;
    this.editAnswer(index, { text: event.currentTarget.value ?? '' });
  }

  private submitAnswers(): void {
    const data = this.permission.data;
    if (!this.hasAnyAnswer(data)) {
      this.renderRoot
        .querySelector<HTMLElement>('wa-radio-group, wa-checkbox, wa-textarea')
        ?.focus();
      return;
    }
    const answers: Record<string, UserQuestionAnswers[string]> = {};

    for (const [index, question] of data.questions.entries()) {
      const custom = this.answerAt(index).text.trim();
      const selected = this.answerAt(index).selected;
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

  private hasAnyAnswer(data: UserQuestionRequest): boolean {
    return data.questions.some((_question, index) => {
      const answer = this.answerAt(index);
      return answer.text.trim() !== '' || answer.selected.length > 0;
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'user-question-panel': UserQuestionPanel;
  }
}
