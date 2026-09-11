import { Effect } from 'effect';
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, vi } from 'vitest';
import { it } from '@effect/vitest';

const submitFollowUpMock = vi.hoisted(() => vi.fn());
const getThreadSummaryMock = vi.hoisted(() => vi.fn());
const listThreadsByStatusMock = vi.hoisted(() => vi.fn());
const readExternalInquiryThreadMock = vi.hoisted(() => vi.fn());

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  submitFollowUp: submitFollowUpMock,
}));

const records = {
  getThreadSummary: getThreadSummaryMock,
  listThreadsByStatus: listThreadsByStatusMock,
  readExternalInquiryThread: readExternalInquiryThreadMock,
  recordOpenQuestion: vi.fn(),
  recordAnswerForOpenTurn: vi.fn(),
  markDropped: vi.fn(),
};

import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import {
  type InquiryThreadRecord,
  aggregateId as qualifyAggregateId,
  type InquiryThreadId,
  RunIdSchema,
} from '@shared/schemas';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';

import {
  injectContinuationForAnsweredThread,
  type InjectionOutcome,
} from '@tools/inquiry/inquiryContinuation';
import { recordSessionEvents } from '../agent/progressTestUtils';

const THREAD = 'ei_aabbccdd0011' as InquiryThreadId;
const PARENT_RUN = RunIdSchema.parse('d5e700000001');

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
  readonly read: () => Promise<unknown[]>;
  detach: () => void;
} {
  const stub = session as Partial<ReturnType<typeof sessionStub>>;
  if (stub.published)
    return { read: async () => stub.published!, detach: () => {} };
  const recorded = recordSessionEvents(session);
  return {
    read: () => recorded.read(),
    detach: () => {},
  };
}

function answeredManifest(): InquiryThreadRecord {
  return {
    threadId: THREAD,
    parentRunId: PARENT_RUN,
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
    submitFollowUpMock
      .mockReset()
      .mockReturnValue(Effect.succeed({ status: 'sent' }));
    getThreadSummaryMock.mockReturnValue(
      Effect.succeed({
        threadId: THREAD,
        parentRunId: PARENT_RUN,
        status: 'answered',
        lastQuestionPreview: 'Check the boundary case.',
        lastActivityIso: '2026-06-14T08:01:00.000Z',
        turnCount: 1,
      }),
    );
    listThreadsByStatusMock.mockReset().mockReturnValue(Effect.succeed([]));
    readExternalInquiryThreadMock.mockClear();
  });

  it.effect('passes the host-provided session through to sendFollowUp', () =>
    Effect.gen(function* () {
      const session = sessionStub('desktop-session');

      const outcome: InjectionOutcome =
        yield* injectContinuationForAnsweredThread(
          THREAD,
          answeredManifest(),
          session,
        ).pipe(Effect.provideService(InquiryRecords, records));

      expect(outcome).toBe('sent');
      expect(submitFollowUpMock).toHaveBeenCalledWith(
        PARENT_RUN,
        expect.stringContaining('[inquiry] ei_aabbccdd0011 answered.'),
        { session },
      );
    }),
  );

  it.effect(
    'archives a turn-less manifest without dispatching a follow-up',
    () =>
      Effect.gen(function* () {
        // The manifest schema does not require turns; the structural guard must
        // archive (not crash) when there is no turn to fence against.
        const outcome = yield* injectContinuationForAnsweredThread(
          THREAD,
          {
            ...answeredManifest(),
            turns: [],
          },
          sessionStub(),
        ).pipe(Effect.provideService(InquiryRecords, records));

        expect(outcome).toBe('archived');
        expect(submitFollowUpMock).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'emits inquiry thread updates through the explicit session plane',
    () =>
      Effect.gen(function* () {
        const session = createTestSession({ roots: paperRoots() });
        publishTestRunStart(session, PARENT_RUN);
        yield* Effect.promise(() => session.settlePublications());
        const explicit = captureFacts(session);
        const fallback = captureFacts(defaultSession());

        try {
          yield* injectContinuationForAnsweredThread(
            THREAD,
            answeredManifest(),
            session,
          ).pipe(Effect.provideService(InquiryRecords, records));
          yield* Effect.promise(() => session.settlePublications());

          yield* Effect.promise(() => session.settlePublications());
          expect(yield* Effect.promise(() => explicit.read())).toMatchObject([
            {
              type: 'inquiryThreadUpdated',
              aggregateId: qualifyAggregateId('inquiry', THREAD),
              threadId: THREAD,
              parentRunId: PARENT_RUN,
              status: 'answered',
              lastQuestionPreview: 'Check the boundary case.',
              lastActivityIso: '2026-06-14T08:01:00.000Z',
              turnCount: 1,
              resumeOutcome: 'sent',
            },
          ]);
          expect(yield* Effect.promise(() => fallback.read())).toEqual([]);
        } finally {
          explicit.detach();
          fallback.detach();
          session.dispose();
        }
      }),
  );

  it.effect(
    'does not emit an inquiry thread update when no summary is returned',
    () =>
      Effect.gen(function* () {
        const session = createTestSession();
        const { read, detach } = captureFacts(session);
        getThreadSummaryMock.mockReturnValueOnce(Effect.succeed(null));

        try {
          yield* injectContinuationForAnsweredThread(
            THREAD,
            answeredManifest(),
            session,
          ).pipe(Effect.provideService(InquiryRecords, records));

          expect(yield* Effect.promise(() => read())).toEqual([]);
        } finally {
          detach();
          session.dispose();
        }
      }),
  );

  it.effect.each([
    {
      name: 'threads the provided session to the wake decision',
      session: sessionStub('desktop-session'),
    },
  ])(
    'delegates queued wake decisions to the follow-up owner ($name)',
    ({ session }) =>
      Effect.gen(function* () {
        submitFollowUpMock.mockReturnValueOnce(
          Effect.succeed({ status: 'queued' }),
        );

        const outcome = yield* injectContinuationForAnsweredThread(
          THREAD,
          answeredManifest(),
          session,
        ).pipe(Effect.provideService(InquiryRecords, records));

        expect(outcome).toBe('queued');
      }),
  );

  it.effect(
    'archives inquiries when the follow-up owner refuses a stale queue',
    () =>
      Effect.gen(function* () {
        submitFollowUpMock.mockReturnValueOnce(
          Effect.succeed({
            status: 'failed' as const,
            reason: 'not_resumable' as const,
          }),
        );

        const outcome = yield* injectContinuationForAnsweredThread(
          THREAD,
          answeredManifest(),
          sessionStub(),
        ).pipe(Effect.provideService(InquiryRecords, records));

        expect(outcome).toBe('archived');
      }),
  );
});
