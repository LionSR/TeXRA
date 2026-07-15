// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type {
  HostInteractionSettlement,
  HostInteractions,
} from '@agent/runtime/HostInteractions';
import { defaultSession } from '@agent/runtime/SessionHandle';
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
  let detach: (() => void) | undefined;
  let resolve: ReturnType<
    typeof vi.fn<
      (requestId: string, settlement: HostInteractionSettlement) => boolean
    >
  >;

  beforeEach(() => {
    vi.clearAllMocks();
    storageMocks.recordAnswerForOpenTurn.mockResolvedValue(null);
    storageMocks.markDropped.mockResolvedValue(null);
    resolve = vi.fn<
      (requestId: string, settlement: HostInteractionSettlement) => boolean
    >(() => true);
    const interactions: HostInteractions = {
      resolve,
      cancel: () => {},
    };
    detach = defaultSession().useHostInteractions(interactions);
  });

  afterEach(() => {
    detach?.();
    detach = undefined;
  });

  it('resolves extension submit actions through the default session', async () => {
    await handleExternalInquiryAction({
      action: 'submit',
      threadId: 'thread-submit',
      answer: 'A proof follows by compactness.',
    });

    expect(resolve).toHaveBeenCalledWith('thread-submit', {
      kind: 'externalInquiry',
    });
  });

  it('resolves extension drop actions through the default session', async () => {
    await handleExternalInquiryAction({
      action: 'drop',
      threadId: 'thread-drop',
      feedback: 'The question is no longer needed.',
    });

    expect(resolve).toHaveBeenCalledWith('thread-drop', {
      kind: 'externalInquiry',
    });
  });
});
