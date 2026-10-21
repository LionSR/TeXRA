import type {
  UserQuestionAnswers,
  UserQuestionPrompt,
} from '@texra-ai/harness/schemas';

export function updateUserQuestionAnswers(
  answers: UserQuestionAnswers,
  question: UserQuestionPrompt,
  answer: string | string[] | undefined,
): UserQuestionAnswers {
  if (answer == null || (Array.isArray(answer) && answer.length === 0)) {
    return answers;
  }
  return { ...answers, [question.question]: answer };
}

export function toggleUserQuestionSelection(
  selected: readonly string[],
  label: string,
): string[] {
  return selected.includes(label)
    ? selected.filter((item) => item !== label)
    : [...selected, label];
}
