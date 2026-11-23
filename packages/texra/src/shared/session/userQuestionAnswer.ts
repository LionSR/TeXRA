/**
 * The answer a `userQuestion` request gets from what a person entered: the
 * progress view's panel, the TUI's modal and the headless prompt each collect
 * picked options and typed text their own way and read the answer here, so
 * one question gets one answer shape on all of them.
 *
 * Pure and host-neutral: it reaches the harness's schemas and nothing else.
 */

import type {
  RequestDecision,
  UserQuestionAnswers,
  UserQuestionPrompt,
} from '@texra-ai/worldline/schemas';

/** What a person entered for one question: the option labels they picked
 *  and the text they typed. */
export interface UserQuestionEntry {
  readonly selected: readonly string[];
  readonly text: string;
}

/**
 * One question's answer, or `undefined` when nothing was entered. Typed text
 * counts only where the question allows it. A multi-select question holds a
 * list, so the text adds to the picked options; a single-select question
 * holds one answer, so the text replaces the picked option.
 */
function userQuestionAnswer(
  question: UserQuestionPrompt,
  entry: UserQuestionEntry,
): UserQuestionAnswers[string] | undefined {
  const text = question.allowFreeText ? entry.text.trim() : '';
  if (question.multiSelect) {
    const answer = [
      ...new Set(text ? [...entry.selected, text] : entry.selected),
    ];
    return answer.length > 0 ? answer : undefined;
  }
  return text || entry.selected[0];
}

/**
 * The decision for a request's questions and what was entered for each, by
 * position (a question with no entry is unanswered). No answer at all skips
 * the request, with no feedback: the tool's own "The user declined to
 * answer" is the one wording.
 */
export function userQuestionDecision(
  questions: readonly UserQuestionPrompt[],
  entries: readonly (UserQuestionEntry | undefined)[],
): RequestDecision {
  const answers: Record<string, UserQuestionAnswers[string]> = {};
  for (const [index, question] of questions.entries()) {
    const entry = entries[index];
    const answer = entry && userQuestionAnswer(question, entry);
    if (answer !== undefined) answers[question.question] = answer;
  }
  return Object.keys(answers).length > 0
    ? { action: 'submit', answers }
    : { action: 'skip' };
}

/**
 * What one typed line enters for a question whose options are numbered from
 * one, as the terminal lists them: comma-separated numbers pick options, and
 * anything else is typed text. On a multi-select question the two mix
 * (`1, 3, something else`); on a single-select one a line that is not all
 * numbers is text as a whole.
 */
export function typedUserQuestionEntry(
  raw: string,
  question: UserQuestionPrompt,
): UserQuestionEntry {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const picked = parts.map((part) =>
    /^\d+$/.test(part) ? question.options[Number(part) - 1]?.label : undefined,
  );
  const selected = picked.filter((label) => label !== undefined);
  if (question.multiSelect) {
    return {
      selected,
      text: parts
        .filter((_part, index) => picked[index] === undefined)
        .join(', '),
    };
  }
  const numbers = parts.every((part) => /^\d+$/.test(part));
  return numbers && selected.length > 0
    ? { selected, text: '' }
    : { selected: [], text: raw.trim() };
}
