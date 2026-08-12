// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

const storageMocks = vi.hoisted(() => ({
  ensureExternalInquiryThreadMirror: vi.fn(),
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

vi.mock('@tools/inquiry/externalInquiryStorage', () => storageMocks);

vi.mock('@tools/inquiry/inquiryContinuation', () => continuationMocks);

describe('handleExternalInquiryAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists and continues submit actions', async () => {
    const manifest = { status: 'answered' };
    storageMocks.recordAnswerForOpenTurn.mockResolvedValue({ manifest });

    await handleExternalInquiryAction({
      action: 'submit',
      threadId: 'thread-submit',
      answer: 'A proof follows by compactness.',
    });

    expect(storageMocks.recordAnswerForOpenTurn).toHaveBeenCalledWith({
      threadId: 'thread-submit',
      answer: 'A proof follows by compactness.',
      sessionLinks: undefined,
    });
    expect(
      continuationMocks.injectContinuationForAnsweredThread,
    ).toHaveBeenCalledWith('thread-submit', manifest, undefined);
  });

  it('persists and continues drop actions', async () => {
    const manifest = { status: 'dropped' };
    storageMocks.markDropped.mockResolvedValue(manifest);

    await handleExternalInquiryAction({
      action: 'drop',
      threadId: 'thread-drop',
    });

    expect(storageMocks.markDropped).toHaveBeenCalledWith({
      threadId: 'thread-drop',
    });
    expect(
      continuationMocks.injectContinuationForDroppedThread,
    ).toHaveBeenCalledWith('thread-drop', manifest, undefined);
  });
});
