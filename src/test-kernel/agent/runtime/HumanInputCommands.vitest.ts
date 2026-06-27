import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handleExternalInquiryAction: vi.fn(),
  handleUserQuestionAction: vi.fn(),
  persistOpenTurnDraft: vi.fn(),
}));

vi.mock('@tools/userQuestion', () => ({
  handleUserQuestionAction: mocks.handleUserQuestionAction,
}));

vi.mock('@tools/inquiry/ExternalInquiryTool', () => ({
  handleExternalInquiryAction: mocks.handleExternalInquiryAction,
}));

vi.mock('@tools/inquiry/externalInquiryStorage', () => ({
  persistOpenTurnDraft: mocks.persistOpenTurnDraft,
}));

import {
  persistRuntimeExternalInquiryDraft,
  resolveRuntimeExternalInquiry,
  resolveRuntimeUserQuestion,
} from '@agent/runtime/humanInputCommands';
import { SessionHandle } from '@agent/runtime/SessionHandle';

describe('runtime human-input commands', () => {
  it('resolves user questions through the runtime command boundary', async () => {
    await resolveRuntimeUserQuestion({
      requestId: 'question-1',
      action: 'submit',
      answers: { 'Which lemma?': 'Arzela-Ascoli' },
    });

    expect(mocks.handleUserQuestionAction).toHaveBeenCalledWith({
      requestId: 'question-1',
      action: 'submit',
      answers: { 'Which lemma?': 'Arzela-Ascoli' },
    });
  });

  it('resolves external inquiries with the owning runtime session', async () => {
    const session = new SessionHandle();

    try {
      await resolveRuntimeExternalInquiry({
        action: 'drop',
        threadId: 'thread-1',
        feedback: 'No external answer.',
        session,
      });

      expect(mocks.handleExternalInquiryAction).toHaveBeenCalledWith(
        {
          action: 'drop',
          threadId: 'thread-1',
          feedback: 'No external answer.',
        },
        { session },
      );
    } finally {
      session.dispose();
    }
  });

  it('persists external inquiry drafts through the runtime command boundary', async () => {
    const draft = {
      answer: 'A possible answer.',
      sessionLinks: '',
    };

    await persistRuntimeExternalInquiryDraft({
      threadId: 'thread-2',
      draft,
    });

    expect(mocks.persistOpenTurnDraft).toHaveBeenCalledWith({
      threadId: 'thread-2',
      draft,
    });
  });
});
