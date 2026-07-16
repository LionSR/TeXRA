import type { UserQuestionPrompt } from '@shared/schemas';

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
