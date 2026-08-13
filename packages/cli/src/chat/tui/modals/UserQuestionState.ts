import { USER_QUESTION_SKIPPED_FEEDBACK } from '@cli/runtime/userQuestionAnswer';
import type { UserQuestionAnswers, UserQuestionPrompt } from '@shared/schemas';

import type { ApprovalDecision } from '../state/approvalQueue';

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
): ApprovalDecision {
  if (Object.keys(answers).length === 0) {
    return {
      accepted: false,
      userMessage: USER_QUESTION_SKIPPED_FEEDBACK,
    };
  }
  return { accepted: true, userQuestionAnswers: answers };
}
