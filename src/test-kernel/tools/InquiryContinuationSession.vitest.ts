// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const submitFollowUpMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    status: 'sent' as const,
  })),
);
const getThreadSummaryMock = vi.hoisted(() => vi.fn());
const listOpenThreadsForStreamMock = vi.hoisted(() => vi.fn(async () => []));
const readExternalInquiryThreadMock = vi.hoisted(() => vi.fn());

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  submitFollowUp: submitFollowUpMock,
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

import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { ExternalInquiryThreadId, StreamTabId } from '@shared/schemas';
import { createRecordingHost } from '@test/agent/progressTestUtils';
import { createTestSession } from '@test/support/sessionTestUtils';
import {
  injectContinuationForAnsweredThread,
  type InjectionOutcome,
} from '@tools/inquiry/inquiryContinuation';
import type { ExternalInquiryThreadManifest } from '@tools/inquiry/externalInquiryStorage';

const THREAD = 'ei_aabbccdd0011' as ExternalInquiryThreadId;
const STREAM = 'stream:desktop-parent' as StreamTabId;

function answeredManifest(): ExternalInquiryThreadManifest {
  return {
    schemaVersion: 1,
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
    submitFollowUpMock.mockClear();
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
    expect(submitFollowUpMock).toHaveBeenCalledWith(
      STREAM,
      expect.stringContaining('[inquiry] ei_aabbccdd0011 answered.'),
      { session },
    );
  });

  it('emits inquiry thread updates through the explicit session hub', async () => {
    const session = createTestSession();
    const explicitFacts: unknown[] = [];
    const defaultFacts: unknown[] = [];
    const detachExplicitFacts = session.events.subscribe((event) => {
      explicitFacts.push(event);
    });
    const detachDefaultFacts = defaultSession().events.subscribe((event) => {
      defaultFacts.push(event);
    });

    try {
      await injectContinuationForAnsweredThread(
        THREAD,
        answeredManifest(),
        session,
      );

      expect(explicitFacts).toEqual([
        {
          scope: 'session',
          event: {
            type: 'inquiryThreadUpdated',
            payload: {
              threadId: THREAD,
              parentStreamId: STREAM,
              status: 'answered',
              lastQuestionPreview: 'Check the boundary case.',
              lastActivityIso: '2026-06-14T08:01:00.000Z',
              turnCount: 1,
              resumeOutcome: 'sent',
            },
          },
        },
      ]);
      expect(defaultFacts).toEqual([]);
    } finally {
      detachExplicitFacts();
      detachDefaultFacts();
      session.dispose();
    }
  });

  it("emits inquiry thread updates through the active run's session when no explicit session is provided", async () => {
    const { host } = createRecordingHost();
    const session = createTestSession();
    const runFacts: unknown[] = [];
    const defaultFacts: unknown[] = [];
    const detachRunFacts = session.events.subscribe((event) => {
      runFacts.push(event);
    });
    const detachDefaultFacts = defaultSession().events.subscribe((event) => {
      defaultFacts.push(event);
    });

    try {
      await withRunContext(
        createRunContext({
          runtimeHost: host,
          session,
        }),
        () => injectContinuationForAnsweredThread(THREAD, answeredManifest()),
      );

      expect(runFacts).toEqual([
        {
          scope: 'session',
          event: {
            type: 'inquiryThreadUpdated',
            payload: expect.objectContaining({
              threadId: THREAD,
              resumeOutcome: 'sent',
            }),
          },
        },
      ]);
      expect(defaultFacts).toEqual([]);
    } finally {
      detachRunFacts();
      detachDefaultFacts();
      session.dispose();
    }
  });

  it('falls back to the default session when the selected session has no event hub', async () => {
    const { host } = createRecordingHost();
    const runSession = createTestSession();
    const runFacts: unknown[] = [];
    const defaultFacts: unknown[] = [];
    const detachRunFacts = runSession.events.subscribe((event) => {
      runFacts.push(event);
    });
    const detachDefaultFacts = defaultSession().events.subscribe((event) => {
      defaultFacts.push(event);
    });

    try {
      await withRunContext(
        createRunContext({
          runtimeHost: host,
          session: runSession,
        }),
        () =>
          injectContinuationForAnsweredThread(
            THREAD,
            answeredManifest(),
            {} as SessionHandle,
          ),
      );

      expect(runFacts).toEqual([]);
      expect(defaultFacts).toEqual([
        {
          scope: 'session',
          event: {
            type: 'inquiryThreadUpdated',
            payload: expect.objectContaining({
              threadId: THREAD,
              resumeOutcome: 'sent',
            }),
          },
        },
      ]);
    } finally {
      detachRunFacts();
      detachDefaultFacts();
      runSession.dispose();
    }
  });

  it('does not emit an inquiry thread update when no summary is returned', async () => {
    const session = createTestSession();
    const facts: unknown[] = [];
    const detachFacts = session.events.subscribe((event) => {
      facts.push(event);
    });
    getThreadSummaryMock.mockResolvedValueOnce(null);

    try {
      await injectContinuationForAnsweredThread(
        THREAD,
        answeredManifest(),
        session,
      );

      expect(facts).toEqual([]);
    } finally {
      detachFacts();
      session.dispose();
    }
  });

  it('delegates queued wake decisions to the follow-up owner, threading the session', async () => {
    const session = { tag: 'desktop-session' } as unknown as SessionHandle;
    submitFollowUpMock.mockResolvedValueOnce({
      status: 'queued',
      reason: 'waiting',
      continuation: 'resumed' as const,
    });

    const outcome = await injectContinuationForAnsweredThread(
      THREAD,
      answeredManifest(),
      session,
    );

    expect(outcome).toBe('resumed');
  });

  it('passes an undefined session through to the wake decision when none was provided', async () => {
    submitFollowUpMock.mockResolvedValueOnce({
      status: 'queued',
      reason: 'waiting',
      continuation: 'resumed' as const,
    });

    const outcome = await injectContinuationForAnsweredThread(
      THREAD,
      answeredManifest(),
    );

    expect(outcome).toBe('resumed');
  });

  it('archives inquiries when the follow-up owner drops a stale queue', async () => {
    submitFollowUpMock.mockResolvedValueOnce({
      status: 'dropped' as const,
    });

    const outcome = await injectContinuationForAnsweredThread(
      THREAD,
      answeredManifest(),
    );

    expect(outcome).toBe('archived');
  });
});
