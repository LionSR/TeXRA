import { describe, expect, it } from 'vitest';

import { USER_QUESTION_SKIPPED_FEEDBACK } from '@cli/runtime/userQuestionAnswer';
import {
  toggleUserQuestionSelection,
  updateUserQuestionAnswers,
  userQuestionDecision,
} from '@cli/chat/tui/modals/UserQuestionState';

const question = {
  question: 'Which path should the agent take?',
  options: [{ label: 'Short proof' }, { label: 'Detailed proof' }],
};

describe('CLI user-question modal state', () => {
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
