import { USER_QUESTION_SKIPPED_FEEDBACK } from '@cli/runtime/userQuestionAnswer';
import type {
  RequestDecision,
  UserQuestionAnswers,
  UserQuestionPrompt,
} from '@shared/schemas';

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

export function userQuestionDecision(
  answers: UserQuestionAnswers,
): RequestDecision {
  if (Object.keys(answers).length === 0) {
    return { action: 'skip', feedback: USER_QUESTION_SKIPPED_FEEDBACK };
  }
  return { action: 'submit', answers };
}
