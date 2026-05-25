import { describe, expect, it } from 'vitest';

import { parseUserQuestionAnswer } from '@cli/runtime/userQuestionAnswer';

const question = {
  question: 'How long should this take?',
  options: [{ label: 'Short' }, { label: 'Long' }],
  allowFreeText: true,
};

describe('CLI user question answer parsing', () => {
  it('selects numbered options only for exact numeric answers', () => {
    expect(parseUserQuestionAnswer('2', question)).toBe('Long');
  });

  it('keeps leading-digit free text as text', () => {
    expect(parseUserQuestionAnswer('1 hour', question)).toBe('1 hour');
    expect(parseUserQuestionAnswer('2nd option', question)).toBe('2nd option');
  });

  it('parses comma-separated numeric answers for multi-select prompts', () => {
    expect(
      parseUserQuestionAnswer('1, 2', { ...question, multiSelect: true }),
    ).toEqual(['Short', 'Long']);
  });
});
