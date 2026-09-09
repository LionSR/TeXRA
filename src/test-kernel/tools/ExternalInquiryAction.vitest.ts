import { Effect } from 'effect';
// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { beforeEach, describe, expect, vi } from 'vitest';
import { it } from '@effect/vitest';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import { handleExternalInquiryAction } from '@tools/inquiry/inquiryActions';

const storageMocks = vi.hoisted(() => ({
  getThreadSummary: vi.fn(),
  listThreadsByStatus: vi.fn(),
  markDropped: vi.fn(),
  readExternalInquiryThread: vi.fn(),
  recordAnswerForOpenTurn: vi.fn(),
  recordOpenQuestion: vi.fn(),
}));

const continuationMocks = vi.hoisted(() => ({
  injectContinuationForAnsweredThread: vi.fn(),
  injectContinuationForDroppedThread: vi.fn(),
}));

const traceMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@logger/logUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@logger/logUtils')>();
  return {
    ...actual,
    createLog: () => ({
      debug: vi.fn(),
      info: traceMocks.info,
      warn: traceMocks.warn,
      error: vi.fn(),
    }),
  };
});

vi.mock('@tools/inquiry/inquiryContinuation', () => continuationMocks);

const session = {} as SessionHandle;
describe('handleExternalInquiryAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    continuationMocks.injectContinuationForAnsweredThread.mockReturnValue(
      Effect.succeed('sent'),
    );
    continuationMocks.injectContinuationForDroppedThread.mockReturnValue(
      Effect.succeed('sent'),
    );
  });

  it.effect('persists and continues submit actions', () =>
    Effect.gen(function* () {
      const manifest = { status: 'answered' };
      storageMocks.recordAnswerForOpenTurn.mockReturnValue(
        Effect.succeed(manifest),
      );

      yield* handleExternalInquiryAction(
        {
          action: 'submit',
          threadId: 'thread-submit',
          turnIndex: 1,
          answer: 'A proof follows by compactness.',
        },
        { session },
      ).pipe(Effect.provideService(InquiryRecords, storageMocks));

      expect(storageMocks.recordAnswerForOpenTurn).toHaveBeenCalledWith({
        threadId: 'thread-submit',
        turnIndex: 1,
        answer: 'A proof follows by compactness.',
        sessionLinks: undefined,
      });
      expect(
        continuationMocks.injectContinuationForAnsweredThread,
      ).toHaveBeenCalledWith('thread-submit', manifest, session);
    }),
  );

  it.effect('persists note-free drops without synthesizing provenance', () =>
    Effect.gen(function* () {
      const manifest = { status: 'dropped' };
      storageMocks.markDropped.mockReturnValue(Effect.succeed(manifest));

      yield* handleExternalInquiryAction(
        {
          action: 'drop',
          threadId: 'thread-drop',
          turnIndex: 1,
        },
        { session },
      ).pipe(Effect.provideService(InquiryRecords, storageMocks));

      expect(storageMocks.markDropped).toHaveBeenCalledWith({
        threadId: 'thread-drop',
        turnIndex: 1,
      });
      expect(
        continuationMocks.injectContinuationForDroppedThread,
      ).toHaveBeenCalledWith('thread-drop', manifest, session);
      expect(traceMocks.info).not.toHaveBeenCalled();
    }),
  );

  it.effect('logs policy reasons without labeling them as feedback', () =>
    Effect.gen(function* () {
      storageMocks.markDropped.mockReturnValue(
        Effect.succeed({ status: 'dropped' }),
      );

      yield* handleExternalInquiryAction(
        {
          action: 'drop',
          threadId: 'thread-denied',
          turnIndex: 1,
          reason: 'Human input is disabled by policy.',
        },
        { session },
      ).pipe(Effect.provideService(InquiryRecords, storageMocks));

      expect(traceMocks.info).toHaveBeenCalledWith(
        'Inquiry thread-denied denied',
        { data: 'Human input is disabled by policy.' },
      );
    }),
  );

  it.effect('logs lifecycle causes without labeling them as feedback', () =>
    Effect.gen(function* () {
      storageMocks.markDropped.mockReturnValue(
        Effect.succeed({ status: 'dropped' }),
      );

      yield* handleExternalInquiryAction(
        {
          action: 'drop',
          threadId: 'thread-cancelled',
          turnIndex: 1,
          cause: 'Session interrupted.',
        },
        { session },
      ).pipe(Effect.provideService(InquiryRecords, storageMocks));

      expect(traceMocks.info).toHaveBeenCalledWith(
        'Inquiry thread-cancelled dropped with cause',
        { data: 'Session interrupted.' },
      );
    }),
  );
});
