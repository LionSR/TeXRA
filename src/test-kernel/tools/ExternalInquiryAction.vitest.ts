import { Effect } from 'effect';
// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { handleExternalInquiryAction } from '@tools/inquiry/inquiryActions';

const storageMocks = vi.hoisted(() => ({
  getOpenTurnDraft: vi.fn(),
  getThreadSummary: vi.fn(),
  listThreadsByStatus: vi.fn(),
  manifestToTranscript: vi.fn(),
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

vi.mock('@tools/inquiry/externalInquiryStorage', () => storageMocks);

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

  it('persists and continues submit actions', async () => {
    const manifest = { status: 'answered' };
    storageMocks.recordAnswerForOpenTurn.mockResolvedValue(manifest);

    await Effect.runPromise(
      handleExternalInquiryAction(
        {
          action: 'submit',
          threadId: 'thread-submit',
          turnIndex: 1,
          answer: 'A proof follows by compactness.',
        },
        { session },
      ),
    );

    expect(storageMocks.recordAnswerForOpenTurn).toHaveBeenCalledWith({
      threadId: 'thread-submit',
      turnIndex: 1,
      answer: 'A proof follows by compactness.',
      sessionLinks: undefined,
    });
    expect(
      continuationMocks.injectContinuationForAnsweredThread,
    ).toHaveBeenCalledWith('thread-submit', manifest, session);
  });

  it('persists note-free drops without synthesizing provenance', async () => {
    const manifest = { status: 'dropped' };
    storageMocks.markDropped.mockResolvedValue(manifest);

    await Effect.runPromise(
      handleExternalInquiryAction(
        {
          action: 'drop',
          threadId: 'thread-drop',
          turnIndex: 1,
        },
        { session },
      ),
    );

    expect(storageMocks.markDropped).toHaveBeenCalledWith({
      threadId: 'thread-drop',
      turnIndex: 1,
    });
    expect(
      continuationMocks.injectContinuationForDroppedThread,
    ).toHaveBeenCalledWith('thread-drop', manifest, session);
    expect(traceMocks.info).not.toHaveBeenCalled();
  });

  it('logs policy reasons without labeling them as feedback', async () => {
    storageMocks.markDropped.mockResolvedValue({ status: 'dropped' });

    await Effect.runPromise(
      handleExternalInquiryAction(
        {
          action: 'drop',
          threadId: 'thread-denied',
          turnIndex: 1,
          reason: 'Human input is disabled by policy.',
        },
        { session },
      ),
    );

    expect(traceMocks.info).toHaveBeenCalledWith(
      'Inquiry thread-denied denied',
      { data: 'Human input is disabled by policy.' },
    );
  });

  it('logs lifecycle causes without labeling them as feedback', async () => {
    storageMocks.markDropped.mockResolvedValue({ status: 'dropped' });

    await Effect.runPromise(
      handleExternalInquiryAction(
        {
          action: 'drop',
          threadId: 'thread-cancelled',
          turnIndex: 1,
          cause: 'Session interrupted.',
        },
        { session },
      ),
    );

    expect(traceMocks.info).toHaveBeenCalledWith(
      'Inquiry thread-cancelled dropped with cause',
      { data: 'Session interrupted.' },
    );
  });
});
