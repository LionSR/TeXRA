import { describe, expect, it } from 'vitest';

import {
  toggleUserQuestionSelection,
  updateUserQuestionAnswers,
  USER_QUESTION_SKIPPED_FEEDBACK,
  userQuestionDecision,
} from '../../../packages/cli/src/chat/tui/modals/UserQuestionState';

const question = {
  question: 'Which path should the agent take?',
  options: [{ label: 'Short proof' }, { label: 'Detailed proof' }],
};

describe('CLI user-question modal state', () => {
  it('toggles multi-select choices without duplicating labels', () => {
    expect(toggleUserQuestionSelection([], 'Short proof')).toEqual([
      'Short proof',
    ]);
    expect(
      toggleUserQuestionSelection(['Short proof'], 'Detailed proof'),
    ).toEqual(['Short proof', 'Detailed proof']);
    expect(
      toggleUserQuestionSelection(
        ['Short proof', 'Detailed proof'],
        'Short proof',
      ),
    ).toEqual(['Detailed proof']);
  });

  it('records answers under the original question text', () => {
    expect(updateUserQuestionAnswers({}, question, 'Detailed proof')).toEqual({
      'Which path should the agent take?': 'Detailed proof',
    });
    expect(updateUserQuestionAnswers({}, question, [])).toEqual({});
    expect(updateUserQuestionAnswers({}, question, undefined)).toEqual({});
  });

  it('submits structured answers and skips empty submissions', () => {
    const answers = {
      'Which path should the agent take?': ['Short proof', 'Detailed proof'],
    };
    expect(userQuestionDecision(answers)).toEqual({
      accepted: true,
      userQuestionAnswers: answers,
    });
    expect(userQuestionDecision({})).toEqual({
      accepted: false,
      userMessage: USER_QUESTION_SKIPPED_FEEDBACK,
    });
  });
});
