/** User question card: "Answer 2 questions", the questions, Submit / Skip. */

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
import type {
  UserQuestionAnswers,
  UserQuestionPermission,
  UserQuestionPrompt,
} from '@shared/schemas';

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

// Local imports - styles
import { userQuestionPanelStyles } from './UserQuestionPanel.styles';

@customElement('user-question-panel')
export class UserQuestionPanel extends BaseRequestPanel<'userQuestion'> {
  static override styles = [BaseRequestPanel.styles, userQuestionPanelStyles];

  // Indexed by question position (not `question.question`): two questions
  // with identical wording would otherwise collide on a text key, both in
  // Lit's `repeat` reconciliation and in these state maps.
  @state() private selections: string[][] = [];
  @state() private freeText: string[] = [];

  protected override get primaryLabel(): string {
    return 'Submit';
  }

  protected override get decline(): 'skip' {
    return 'skip';
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
    const data = this.permission.data;
    if (!this.hasAnyAnswer(data)) {
      this.renderRoot
        .querySelector<HTMLElement>('wa-radio-group, wa-checkbox, wa-textarea')
        ?.focus();
      return;
    }
    // Submission itself still collapses onto `UserQuestionAnswersSchema`'s
    // question-text keys (the AskUserQuestion wire vocabulary has no other
    // id): two identically-worded questions answered independently above
    // will silently collapse into one entry here. Pre-existing limitation,
    // not introduced by the position-indexed state above.
    const answers: UserQuestionAnswers = {};

    for (const [index, question] of data.questions.entries()) {
      const custom = this.freeText[index]?.trim();
      const selected = this.selections[index] ?? [];
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
