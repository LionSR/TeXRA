import { Record } from 'effect';

import type {
  RequestDecision,
  UserQuestionAnswers,
  UserQuestionPrompt,
} from '@texra-ai/harness/schemas';

/** An empty answer set skips the question; otherwise it submits the answers.
 *  A plain skip carries no feedback: the tool's own "The user declined to
 *  answer" is the one wording, the same text the webview's skip produces. */
export function userQuestionDecision(
  answers: UserQuestionAnswers,
): RequestDecision {
  if (Record.isEmptyRecord(answers)) {
    return { action: 'skip' };
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
