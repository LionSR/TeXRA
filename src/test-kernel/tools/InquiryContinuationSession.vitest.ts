import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const submitFollowUpMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    status: 'sent' as const,
  })),
);
const getThreadSummaryMock = vi.hoisted(() => vi.fn());
const listThreadsByStatusMock = vi.hoisted(() => vi.fn(async () => []));
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
  listThreadsByStatus: listThreadsByStatusMock,
  readExternalInquiryThread: readExternalInquiryThreadMock,
}));

import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { InquiryThreadId, StreamTabId } from '@shared/schemas';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { createTestSession } from '@test/support/sessionTestUtils';

import {
  injectContinuationForAnsweredThread,
  type InjectionOutcome,
} from '@tools/inquiry/inquiryContinuation';
import type { ExternalInquiryThreadManifest } from '@tools/inquiry/externalInquiryStorage';
import { recordSessionEvents } from '../agent/progressTestUtils';

const THREAD = 'ei_aabbccdd0011' as InquiryThreadId;
const STREAM = 'stream:desktop-parent' as StreamTabId;

/**
 * A host-supplied session: only identity plus the publisher the continuation
 * publishes on; every fact lands in `published`.
 */
function sessionStub(tag?: string): SessionHandle & { published: unknown[] } {
  const published: unknown[] = [];
  return {
    ...(tag ? { tag } : {}),
    published,
    publish: (events: readonly unknown[]) => {
      published.push(...events);
    },
  } as unknown as SessionHandle & { published: unknown[] };
}

let paperCount = 0;

/** The roots of one paper: a session's plane is keyed by its storage root. */
function paperRoots() {
  paperCount += 1;
  return createFakeWorkspaceRoots({
    storagePath: `/workspace/inquiry-${paperCount}/.texra/storage`,
  });
}

/** The facts a session published from this call on: a stub's array, or a
 *  real session's plane read back. */
function captureFacts(session: SessionHandle): {
  readonly facts: unknown[];
  detach: () => void;
} {
  const stub = session as Partial<ReturnType<typeof sessionStub>>;
  if (stub.published) return { facts: stub.published, detach: () => {} };
  const recorded = recordSessionEvents(session);
  return {
    get facts() {
      return recorded.events;
    },
    detach: () => {},
  };
}

function answeredManifest(): ExternalInquiryThreadManifest {
  return {
    schemaVersion: 1,
    threadId: THREAD,
    parentStreamId: STREAM,
    parentExecutionId: null,
    status: 'answered',
    createdAt: '2026-06-14T08:00:00.000Z',
    updatedAt: '2026-06-14T08:01:00.000Z',
    turns: [
      {
        kind: 'answered',
        turnIndex: 1,
        timestamp: '2026-06-14T08:00:00.000Z',
        question: 'Check the boundary case.',
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
      parentExecutionId: null,
      status: 'answered',
      lastQuestionPreview: 'Check the boundary case.',
      lastActivityIso: '2026-06-14T08:01:00.000Z',
      turnCount: 1,
    });
    listThreadsByStatusMock.mockClear();
    readExternalInquiryThreadMock.mockClear();
  });

  it('passes the host-provided session through to sendFollowUp', async () => {
    const session = sessionStub('desktop-session');

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

  it('archives a turn-less manifest without dispatching a follow-up', async () => {
    // The manifest schema does not require turns; the structural guard must
    // archive (not crash) when there is no turn to fence against.
    const outcome = await injectContinuationForAnsweredThread(THREAD, {
      ...answeredManifest(),
      turns: [],
    });

    expect(outcome).toBe('archived');
    expect(submitFollowUpMock).not.toHaveBeenCalled();
  });

  it('emits inquiry thread updates through the explicit session plane', async () => {
    const session = createTestSession({ roots: paperRoots() });
    const explicit = captureFacts(session);
    const fallback = captureFacts(defaultSession());

    try {
      await injectContinuationForAnsweredThread(
        THREAD,
        answeredManifest(),
        session,
      );

      expect(explicit.facts).toMatchObject([
        {
          type: 'inquiryThreadUpdated',
          aggregateId: THREAD,
          threadId: THREAD,
          parentStreamId: STREAM,
          parentExecutionId: null,
          status: 'answered',
          lastQuestionPreview: 'Check the boundary case.',
          lastActivityIso: '2026-06-14T08:01:00.000Z',
          turnCount: 1,
          resumeOutcome: 'sent',
        },
      ]);
      expect(fallback.facts).toEqual([]);
    } finally {
      explicit.detach();
      fallback.detach();
      session.dispose();
    }
  });

  it("emits inquiry thread updates through the active run's session when no explicit session is provided", async () => {
    const session = createTestSession({ roots: paperRoots() });
    const run = captureFacts(session);
    const fallback = captureFacts(defaultSession());

    try {
      await withRunContext(
        createRunContext({
          session,
        }),
        () => injectContinuationForAnsweredThread(THREAD, answeredManifest()),
      );

      expect(run.facts).toMatchObject([
        expect.objectContaining({
          type: 'inquiryThreadUpdated',
          aggregateId: THREAD,
          threadId: THREAD,
          resumeOutcome: 'sent',
        }),
      ]);
      expect(fallback.facts).toEqual([]);
    } finally {
      run.detach();
      fallback.detach();
      session.dispose();
    }
  });

  it('does not emit an inquiry thread update when no summary is returned', async () => {
    const session = createTestSession();
    const { facts, detach } = captureFacts(session);
    getThreadSummaryMock.mockResolvedValueOnce(null);

    try {
      await injectContinuationForAnsweredThread(
        THREAD,
        answeredManifest(),
        session,
      );

      expect(facts).toEqual([]);
    } finally {
      detach();
      session.dispose();
    }
  });

  it.each([
    {
      name: 'threads the provided session to the wake decision',
      session: sessionStub('desktop-session'),
    },
    {
      name: 'passes an undefined session when none was provided',
      session: undefined,
    },
  ])(
    'delegates queued wake decisions to the follow-up owner ($name)',
    async ({ session }) => {
      submitFollowUpMock.mockResolvedValueOnce({ status: 'queued' });

      const outcome = await injectContinuationForAnsweredThread(
        THREAD,
        answeredManifest(),
        session,
      );

      expect(outcome).toBe('queued');
    },
  );

  it('archives inquiries when the follow-up owner refuses a stale queue', async () => {
    submitFollowUpMock.mockResolvedValueOnce({
      status: 'failed' as const,
      reason: 'not_resumable' as const,
    });

    const outcome = await injectContinuationForAnsweredThread(
      THREAD,
      answeredManifest(),
    );

    expect(outcome).toBe('archived');
  });
});
