import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestRuntimeFollowUpMock = vi.hoisted(() =>
  vi.fn(async (): Promise<unknown> => ({ outcome: 'sent', accepted: true })),
);
const getThreadSummaryMock = vi.hoisted(() => vi.fn());
const listOpenThreadsForStreamMock = vi.hoisted(() => vi.fn(async () => []));
const readExternalInquiryThreadMock = vi.hoisted(() => vi.fn());

vi.mock('@agent/runtime/followUpCommands', () => ({
  requestRuntimeFollowUp: requestRuntimeFollowUpMock,
}));

vi.mock('@eventBus/ProgressEventBus', () => ({
  bus: { emit: vi.fn() },
}));

vi.mock('@tools/inquiry/externalInquiryStorage', () => ({
  getThreadSummary: getThreadSummaryMock,
  listOpenThreadsForStream: listOpenThreadsForStreamMock,
  readExternalInquiryThread: readExternalInquiryThreadMock,
}));

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ExternalInquiryThreadId, StreamTabId } from '@shared/schemas';
import {
  injectContinuationForAnsweredThread,
  type InjectionOutcome,
} from '@tools/inquiry/inquiryContinuation';
import type { ExternalInquiryThreadManifest } from '@tools/inquiry/externalInquiryStorage';

const THREAD = 'ei_aabbccdd0011' as ExternalInquiryThreadId;
const STREAM = 'stream:desktop-parent' as StreamTabId;

function answeredManifest(): ExternalInquiryThreadManifest {
  return {
    threadId: THREAD,
    parentStreamId: STREAM,
    status: 'answered',
    createdAt: '2026-06-14T08:00:00.000Z',
    updatedAt: '2026-06-14T08:01:00.000Z',
    turns: [
      {
        turnIndex: 1,
        timestamp: '2026-06-14T08:00:00.000Z',
        question: 'Check the boundary case.',
        questionRelativePath: 'question.md',
        answerRelativePath: 'answer.md',
        answer: 'Boundary case holds.',
      },
    ],
  };
}

describe('external inquiry continuation session routing', () => {
  beforeEach(() => {
    requestRuntimeFollowUpMock.mockClear();
    getThreadSummaryMock.mockResolvedValue({
      threadId: THREAD,
      parentStreamId: STREAM,
      status: 'answered',
      lastQuestionPreview: 'Check the boundary case.',
      lastActivityIso: '2026-06-14T08:01:00.000Z',
      turnCount: 1,
    });
    listOpenThreadsForStreamMock.mockClear();
    readExternalInquiryThreadMock.mockClear();
  });

  it('passes the host-provided session through to the runtime follow-up command', async () => {
    const session = { tag: 'desktop-session' } as unknown as SessionHandle;

    const outcome: InjectionOutcome = await injectContinuationForAnsweredThread(
      THREAD,
      answeredManifest(),
      session,
    );

    expect(outcome).toBe('sent');
    expect(requestRuntimeFollowUpMock).toHaveBeenCalledWith({
      streamId: STREAM,
      text: expect.stringContaining('[inquiry] ei_aabbccdd0011 answered.'),
      session,
      wakeQueuedStream: true,
    });
  });

  it('reports resumed when the runtime wake succeeds', async () => {
    requestRuntimeFollowUpMock.mockResolvedValueOnce({
      outcome: 'queued',
      accepted: true,
      queueReason: 'waiting',
      wakeStatus: 'resumed',
    });

    const outcome: InjectionOutcome = await injectContinuationForAnsweredThread(
      THREAD,
      answeredManifest(),
    );

    expect(outcome).toBe('resumed');
  });
});
