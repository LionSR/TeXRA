import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectKnownSessionLinks: vi.fn(),
  handleExternalInquiryAction: vi.fn(),
  handleUserQuestionAction: vi.fn(),
  getOpenTurnDraft: vi.fn(),
  listOpenThreads: vi.fn(),
  listThreadsByStatus: vi.fn(),
  manifestToTranscript: vi.fn(),
  persistOpenTurnDraft: vi.fn(),
  readExternalInquiryThread: vi.fn(),
}));

vi.mock('@tools/userQuestion', () => ({
  handleUserQuestionAction: mocks.handleUserQuestionAction,
}));

vi.mock('@tools/inquiry/ExternalInquiryTool', () => ({
  handleExternalInquiryAction: mocks.handleExternalInquiryAction,
}));

vi.mock('@tools/inquiry/externalInquiryStorage', () => ({
  getOpenTurnDraft: mocks.getOpenTurnDraft,
  listOpenThreads: mocks.listOpenThreads,
  listThreadsByStatus: mocks.listThreadsByStatus,
  manifestToTranscript: mocks.manifestToTranscript,
  persistOpenTurnDraft: mocks.persistOpenTurnDraft,
  readExternalInquiryThread: mocks.readExternalInquiryThread,
}));

vi.mock('@tools/inquiry/externalInquiryResultFormatter', () => ({
  collectKnownSessionLinks: mocks.collectKnownSessionLinks,
}));

import {
  listRuntimeExternalInquiryOverviewThreads,
  listRuntimeOpenExternalInquiryPermissions,
  persistRuntimeExternalInquiryDraft,
  runtimeExternalInquiryPermissionFromManifest,
  resolveRuntimeExternalInquiry,
  resolveRuntimeUserQuestion,
} from '@agent/runtime/humanInputCommands';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type {
  ExternalInquiryThreadId,
  ExternalInquiryThreadSummary,
  InquiryDraft,
  InquiryTranscriptTurn,
  StreamTabId,
} from '@shared/schemas';
import type { ExternalInquiryThreadManifest } from '@tools/inquiry/externalInquiryStorage';

const THREAD_ID = 'ei_abcdef123456' as ExternalInquiryThreadId;
const STREAM_ID = 'root@deepseekT#abcdef123456' as StreamTabId;
const UPDATED_AT = '2026-06-27T00:00:00.000Z';
const DRAFT: InquiryDraft = {
  answer: 'A draft answer',
  sessionLinks: 'https://example.test/session',
};
const TRANSCRIPT: InquiryTranscriptTurn[] = [
  {
    turnIndex: 1,
    timestamp: UPDATED_AT,
    question: 'Can another model check the estimate?',
    context: 'The proof uses a compactness argument.',
  },
];
const MANIFEST: ExternalInquiryThreadManifest = {
  threadId: THREAD_ID,
  parentStreamId: STREAM_ID,
  status: 'open',
  createdAt: UPDATED_AT,
  updatedAt: UPDATED_AT,
  turns: [
    {
      turnIndex: 1,
      timestamp: UPDATED_AT,
      question: 'Can another model check the estimate?',
      context: 'The proof uses a compactness argument.',
      questionRelativePath: 't1/question.txt',
      suggestSearch: true,
      attachFiles: ['proof.tex'],
      draft: DRAFT,
    },
  ],
};

describe('runtime human-input commands', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

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

  it('lists bounded global inquiry summaries for host overview surfaces', async () => {
    const summaries: ExternalInquiryThreadSummary[] = [
      {
        threadId: THREAD_ID,
        parentStreamId: STREAM_ID,
        status: 'open',
        lastQuestionPreview: 'Can another model check the estimate?',
        lastActivityIso: UPDATED_AT,
        turnCount: 1,
      },
    ];
    mocks.listThreadsByStatus.mockResolvedValue(summaries);

    await expect(listRuntimeExternalInquiryOverviewThreads()).resolves.toEqual(
      summaries,
    );

    expect(mocks.listThreadsByStatus).toHaveBeenCalledWith({
      status: 'any',
      scope: 'all',
      limit: 100,
    });
  });

  it('projects an open manifest into an external inquiry permission', () => {
    mocks.collectKnownSessionLinks.mockReturnValue([
      'https://example.test/session',
    ]);
    mocks.getOpenTurnDraft.mockReturnValue(DRAFT);
    mocks.manifestToTranscript.mockReturnValue(TRANSCRIPT);

    expect(runtimeExternalInquiryPermissionFromManifest(MANIFEST)).toEqual({
      requestId: THREAD_ID,
      threadId: THREAD_ID,
      question: 'Can another model check the estimate?',
      context: 'The proof uses a compactness argument.',
      suggestSearch: true,
      attachFiles: ['proof.tex'],
      sessionLinks: ['https://example.test/session'],
      draft: DRAFT,
      transcript: TRANSCRIPT,
      allowBypass: false,
      streamId: STREAM_ID,
    });
  });

  it('hydrates open inquiry permissions and skips unreadable manifests', async () => {
    mocks.listOpenThreads.mockResolvedValue([
      { threadId: THREAD_ID },
      { threadId: 'ei_deadbeef0000' },
    ]);
    mocks.readExternalInquiryThread.mockImplementation(
      async (threadId: string) => (threadId === THREAD_ID ? MANIFEST : null),
    );
    mocks.collectKnownSessionLinks.mockReturnValue(undefined);
    mocks.getOpenTurnDraft.mockReturnValue(undefined);
    mocks.manifestToTranscript.mockReturnValue([]);

    const permissions = await listRuntimeOpenExternalInquiryPermissions();

    expect(permissions).toHaveLength(1);
    expect(permissions[0]?.requestId).toBe(THREAD_ID);
    expect(mocks.readExternalInquiryThread).toHaveBeenCalledWith(THREAD_ID, {
      hydrate: true,
    });
  });
});
