import { describe, expect, it } from 'vitest';

import {
  parseUserQuestionAnswer,
  USER_QUESTION_SKIPPED_FEEDBACK,
  userQuestionDecision,
} from '@cli/runtime/userQuestionAnswer';

const question = {
  question: 'How long should this take?',
  options: [{ label: 'Short' }, { label: 'Long' }],
  allowFreeText: true,
};

describe('CLI user question answer parsing', () => {
  it('selects numbered options only for exact numeric answers', () => {
    expect(parseUserQuestionAnswer('2', question)).toBe('Long');
  });

  it('parses comma-separated numeric answers for multi-select prompts', () => {
    expect(
      parseUserQuestionAnswer('1, 2', { ...question, multiSelect: true }),
    ).toEqual(['Short', 'Long']);
  });
});

describe('CLI user question decision', () => {
  it('submits structured answers and skips empty submissions', () => {
    const answers = {
      'Which path should the agent take?': ['Short proof', 'Detailed proof'],
    };
    expect(userQuestionDecision(answers)).toEqual({
      action: 'submit',
      answers,
    });
    expect(userQuestionDecision({})).toEqual({
      action: 'skip',
      feedback: USER_QUESTION_SKIPPED_FEEDBACK,
    });
  });
});
