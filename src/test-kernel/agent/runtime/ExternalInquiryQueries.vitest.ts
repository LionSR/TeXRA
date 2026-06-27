import { afterEach, describe, expect, it, vi } from 'vitest';

const inquiryStorageMock = vi.hoisted(() => ({
  getOpenTurnDraft: vi.fn(),
  listOpenThreads: vi.fn(),
  listThreadsByStatus: vi.fn(),
  manifestToTranscript: vi.fn(),
  readExternalInquiryThread: vi.fn(),
}));

const inquiryFormatterMock = vi.hoisted(() => ({
  collectKnownSessionLinks: vi.fn(),
}));

vi.mock('@tools/inquiry/externalInquiryStorage', () => inquiryStorageMock);
vi.mock(
  '@tools/inquiry/externalInquiryResultFormatter',
  () => inquiryFormatterMock,
);

import {
  listRuntimeExternalInquiryThreads,
  listRuntimeOpenExternalInquiryPermissions,
  runtimeExternalInquiryPermissionFromManifest,
} from '@agent/runtime/externalInquiryQueries';
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

describe('runtime external inquiry queries', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists inquiry thread summaries through the runtime boundary', async () => {
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
    inquiryStorageMock.listThreadsByStatus.mockResolvedValue(summaries);

    await expect(
      listRuntimeExternalInquiryThreads({
        status: 'any',
        scope: 'all',
        limit: 100,
      }),
    ).resolves.toEqual(summaries);
  });

  it('projects an open manifest into an external inquiry permission', () => {
    inquiryFormatterMock.collectKnownSessionLinks.mockReturnValue([
      'https://example.test/session',
    ]);
    inquiryStorageMock.getOpenTurnDraft.mockReturnValue(DRAFT);
    inquiryStorageMock.manifestToTranscript.mockReturnValue(TRANSCRIPT);

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
    inquiryStorageMock.listOpenThreads.mockResolvedValue([
      { threadId: THREAD_ID },
      { threadId: 'ei_deadbeef0000' },
    ]);
    inquiryStorageMock.readExternalInquiryThread.mockImplementation(
      async (threadId: string) => (threadId === THREAD_ID ? MANIFEST : null),
    );
    inquiryFormatterMock.collectKnownSessionLinks.mockReturnValue(undefined);
    inquiryStorageMock.getOpenTurnDraft.mockReturnValue(undefined);
    inquiryStorageMock.manifestToTranscript.mockReturnValue([]);

    const permissions = await listRuntimeOpenExternalInquiryPermissions();

    expect(permissions).toHaveLength(1);
    expect(permissions[0]?.requestId).toBe(THREAD_ID);
    expect(inquiryStorageMock.readExternalInquiryThread).toHaveBeenCalledWith(
      THREAD_ID,
      { hydrate: true },
    );
  });
});
