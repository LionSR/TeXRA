import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChildTurnState } from '@agent/storage/ExecutionKVStore';

const submitFollowUpMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    status: 'sent' as const,
  })),
);
const getThreadSummaryMock = vi.hoisted(() => vi.fn());
const listThreadsByStatusMock = vi.hoisted(() => vi.fn(async () => []));
const readExternalInquiryThreadMock = vi.hoisted(() => vi.fn());
const readTurnStateMock = vi.hoisted(() =>
  vi.fn<() => Promise<ChildTurnState | null>>(async () => null),
);

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  submitFollowUp: submitFollowUpMock,
}));

vi.mock('@agent/storage/ExecutionKVStore', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@agent/storage/ExecutionKVStore')>();
  return {
    ...original,
    getExecutionStore: () => ({ readTurnState: readTurnStateMock }),
  };
});

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
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type {
  ExecutionId,
  InquiryThreadId,
  StreamTabId,
} from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import {
  injectContinuationForAnsweredThread,
  type InjectionOutcome,
} from '@tools/inquiry/inquiryContinuation';
import type { ExternalInquiryThreadManifest } from '@tools/inquiry/externalInquiryStorage';

const THREAD = 'ei_aabbccdd0011' as InquiryThreadId;
const STREAM = 'stream:desktop-parent' as StreamTabId;
const EXECUTION = 'inquiry-parent-execution' as ExecutionId;

function restoreGeneration(session: SessionHandle): void {
  expect(
    session.followUps.restorePersistedGeneration(STREAM, 'generation-a'),
  ).toBe(true);
}

function sessionStub(tag?: string): SessionHandle {
  return {
    ...(tag ? { tag } : {}),
    followUps: {
      currentGenerationId: () => 'generation-a',
    },
  } as unknown as SessionHandle;
}

function reloadedSession(): SessionHandle {
  return {
    followUps: new ToolUseFollowUpQueue(),
    snapshots: {
      getRunMetadata: () => ({ executionId: EXECUTION }),
    },
    events: defaultSession().events,
  } as unknown as SessionHandle;
}

/** Collects the session facts emitted on a hub until detached. */
function captureFacts(session: SessionHandle): {
  facts: unknown[];
  detach: () => void;
} {
  const facts: unknown[] = [];
  const detach = session.events.subscribe((event) => {
    facts.push(event);
  });
  return { facts, detach };
}

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
        parentGenerationId: 'generation-a',
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
    listThreadsByStatusMock.mockClear();
    readExternalInquiryThreadMock.mockClear();
    readTurnStateMock.mockReset().mockResolvedValue(null);
    restoreGeneration(defaultSession());
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
      { session, expectedGenerationId: 'generation-a' },
    );
  });

  it('archives legacy inquiry answers without a parent generation fence', async () => {
    const manifest = answeredManifest();
    const turns = manifest.turns.map(
      ({ parentGenerationId: _, ...turn }) => turn,
    );

    const outcome = await injectContinuationForAnsweredThread(THREAD, {
      ...manifest,
      turns,
    });

    expect(outcome).toBe('archived');
    expect(submitFollowUpMock).not.toHaveBeenCalled();
  });

  it('restores a matching generation from authoritative turn state after reload', async () => {
    const session = reloadedSession();
    readTurnStateMock.mockResolvedValueOnce({
      lastCompletedTurn: {
        token: 'current-turn',
        deliveryId: 'current-delivery',
        generationId: 'generation-a',
      },
    });

    await expect(
      injectContinuationForAnsweredThread(THREAD, answeredManifest(), session),
    ).resolves.toBe('sent');
    expect(session.followUps.currentGenerationId(STREAM)).toBe('generation-a');
    expect(submitFollowUpMock).toHaveBeenCalledOnce();
  });

  it('rejects an older inquiry when a newer retry owns persisted turn state', async () => {
    const session = reloadedSession();
    readTurnStateMock.mockResolvedValueOnce({
      lastCompletedTurn: {
        token: 'retry-turn',
        deliveryId: 'retry-delivery',
        generationId: 'generation-b',
      },
    });

    await expect(
      injectContinuationForAnsweredThread(THREAD, answeredManifest(), session),
    ).resolves.toBe('archived');
    expect(session.followUps.currentGenerationId(STREAM)).toBeUndefined();
    expect(submitFollowUpMock).not.toHaveBeenCalled();
  });

  it('emits inquiry thread updates through the explicit session hub', async () => {
    const session = createTestSession();
    restoreGeneration(session);
    const explicit = captureFacts(session);
    const fallback = captureFacts(defaultSession());

    try {
      await injectContinuationForAnsweredThread(
        THREAD,
        answeredManifest(),
        session,
      );

      expect(explicit.facts).toEqual([
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
      expect(fallback.facts).toEqual([]);
    } finally {
      explicit.detach();
      fallback.detach();
      session.dispose();
    }
  });

  it("emits inquiry thread updates through the active run's session when no explicit session is provided", async () => {
    const session = createTestSession();
    restoreGeneration(session);
    const run = captureFacts(session);
    const fallback = captureFacts(defaultSession());

    try {
      await withRunContext(
        createRunContext({
          session,
        }),
        () => injectContinuationForAnsweredThread(THREAD, answeredManifest()),
      );

      expect(run.facts).toEqual([
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
      expect(fallback.facts).toEqual([]);
    } finally {
      run.detach();
      fallback.detach();
      session.dispose();
    }
  });

  it('falls back to the default session when the selected session has no event hub', async () => {
    const runSession = createTestSession();
    const run = captureFacts(runSession);
    const fallback = captureFacts(defaultSession());

    try {
      await withRunContext(
        createRunContext({
          session: runSession,
        }),
        () =>
          injectContinuationForAnsweredThread(
            THREAD,
            answeredManifest(),
            sessionStub(),
          ),
      );

      expect(run.facts).toEqual([]);
      expect(fallback.facts).toEqual([
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
      run.detach();
      fallback.detach();
      runSession.dispose();
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
    },
  );

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
