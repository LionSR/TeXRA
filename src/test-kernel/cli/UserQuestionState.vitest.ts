import { describe, expect, it } from 'vitest';

import { USER_QUESTION_SKIPPED_FEEDBACK } from '@cli/runtime/userQuestionAnswer';
import { userQuestionDecision } from '@cli/chat/tui/modals/UserQuestionState';

describe('CLI user-question modal state', () => {
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
