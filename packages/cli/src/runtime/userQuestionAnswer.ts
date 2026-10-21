import type {
  RequestDecision,
  UserQuestionAnswers,
  UserQuestionPrompt,
} from '@texra-ai/harness/schemas';

/**
 * Feedback the agent receives when a user question ends with no answers —
 * one wording for both the TUI modal and the headless prompt adapter.
 */
export const USER_QUESTION_SKIPPED_FEEDBACK = 'User question skipped by user.';

/** An empty answer set skips the question; otherwise it submits the answers. */
export function userQuestionDecision(
  answers: UserQuestionAnswers,
): RequestDecision {
  if (Object.keys(answers).length === 0) {
    return { action: 'skip', feedback: USER_QUESTION_SKIPPED_FEEDBACK };
  }
  return { action: 'submit', answers };
}

export function parseUserQuestionAnswer(
  raw: string,
  question: UserQuestionPrompt,
): string | string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const parts = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const selected = parts.every((part) => /^\d+$/.test(part))
    ? parts
        .map((part) => question.options[Number(part) - 1]?.label)
        .filter((value): value is string => Boolean(value))
    : [];

  if (selected.length > 0) {
    return question.multiSelect ? selected : selected[0];
  }
  return question.allowFreeText ? trimmed : undefined;
}
