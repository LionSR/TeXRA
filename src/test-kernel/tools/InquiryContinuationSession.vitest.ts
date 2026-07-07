import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendFollowUpMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    status: 'sent' as const,
  })),
);
const wakeQueuedFollowUpStreamMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    kind: 'not_required' as const,
  })),
);
const getThreadSummaryMock = vi.hoisted(() => vi.fn());
const listOpenThreadsForStreamMock = vi.hoisted(() => vi.fn(async () => []));
const readExternalInquiryThreadMock = vi.hoisted(() => vi.fn());

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  sendFollowUp: sendFollowUpMock,
  wakeQueuedFollowUpStream: wakeQueuedFollowUpStreamMock,
}));

vi.mock('@eventBus/ProgressEventBus', () => ({
  ProgressEventBus: { emit: vi.fn() },
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({
    agentResume: { tryResumeStream: vi.fn(async () => false) },
  }),
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
        kind: 'answered',
        turnIndex: 1,
        timestamp: '2026-06-14T08:00:00.000Z',
        question: 'Check the boundary case.',
        questionRelativePath: 'question.md',
        answerRelativePath: 'answer.md',
        answer: 'Boundary case holds.',
        answeredAt: '2026-06-14T08:01:00.000Z',
      },
    ],
  };
}

describe('external inquiry continuation session routing', () => {
  beforeEach(() => {
    sendFollowUpMock.mockClear();
    wakeQueuedFollowUpStreamMock.mockReset();
    wakeQueuedFollowUpStreamMock.mockResolvedValue({
      kind: 'not_required' as const,
    });
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

  it('passes the host-provided session through to sendFollowUp', async () => {
    const session = { tag: 'desktop-session' } as unknown as SessionHandle;

    const outcome: InjectionOutcome = await injectContinuationForAnsweredThread(
      THREAD,
      answeredManifest(),
      session,
    );

    expect(outcome).toBe('sent');
    expect(sendFollowUpMock).toHaveBeenCalledWith(
      STREAM,
      expect.stringContaining('[inquiry] ei_aabbccdd0011 answered.'),
      undefined,
      undefined,
      session,
    );
    // The wake/resume/release decision must route to the same session
    // that owns this continuation (e.g. a desktop window), not fall back
    // to currentSession() / the platform default.
    expect(wakeQueuedFollowUpStreamMock).toHaveBeenCalledWith(
      STREAM,
      { status: 'sent' },
      undefined,
      session,
    );
  });

  it('delegates queued wake decisions to the follow-up owner, threading the session', async () => {
    const session = { tag: 'desktop-session' } as unknown as SessionHandle;
    sendFollowUpMock.mockResolvedValueOnce({
      status: 'queued',
      reason: 'waiting',
    });
    wakeQueuedFollowUpStreamMock.mockResolvedValueOnce({
      kind: 'resumed' as const,
    });

    const outcome = await injectContinuationForAnsweredThread(
      THREAD,
      answeredManifest(),
      session,
    );

    expect(outcome).toBe('resumed');
    expect(wakeQueuedFollowUpStreamMock).toHaveBeenCalledWith(
      STREAM,
      { status: 'queued', reason: 'waiting' },
      undefined,
      session,
    );
  });

  it('passes an undefined session through to the wake decision when none was provided', async () => {
    sendFollowUpMock.mockResolvedValueOnce({
      status: 'queued',
      reason: 'waiting',
    });
    wakeQueuedFollowUpStreamMock.mockResolvedValueOnce({
      kind: 'resumed' as const,
    });

    const outcome = await injectContinuationForAnsweredThread(
      THREAD,
      answeredManifest(),
    );

    expect(outcome).toBe('resumed');
    expect(wakeQueuedFollowUpStreamMock).toHaveBeenCalledWith(
      STREAM,
      { status: 'queued', reason: 'waiting' },
      undefined,
      undefined,
    );
  });

  it('archives inquiries when the follow-up owner drops a stale queue', async () => {
    sendFollowUpMock.mockResolvedValueOnce({
      status: 'queued',
      reason: 'children_running',
    });
    wakeQueuedFollowUpStreamMock.mockResolvedValueOnce({
      kind: 'dropped' as const,
    });

    const outcome = await injectContinuationForAnsweredThread(
      THREAD,
      answeredManifest(),
    );

    expect(outcome).toBe('archived');
  });
});
