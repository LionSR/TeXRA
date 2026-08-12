// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockSendFollowUpResult =
  | { status: 'sent' }
  | { status: 'queued'; reason: 'waiting' }
  | { status: 'no_session'; streamStatus: string | undefined };

const submitFollowUpMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<MockSendFollowUpResult>>(async () => ({
    status: 'sent',
  })),
);

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  submitFollowUp: submitFollowUpMock,
}));

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import { ExecutionSubscriptionBinder } from '@agent/runtime/ExecutionSubscriptionBinder';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { StreamTabId } from '@shared/schemas';

// Test support imports
import {
  testExecutionHandle,
  testExecutionRegistry,
} from '@test/support/executionHandleFixtures';
import { createTestSession } from '@test/support/sessionTestUtils';

// Local file imports
import { recordSessionEvents } from '../progressTestUtils';

const streamId = 'stream:subscription-session' as StreamTabId;
const childStreamId = 'child:subscription-session' as StreamTabId;

function createReleaseSource() {
  let observer: ((streamId: StreamTabId) => void) | undefined;
  return {
    source: {
      onRelease(nextObserver: (streamId: StreamTabId) => void): () => void {
        observer = nextObserver;
        return () => {
          if (observer === nextObserver) observer = undefined;
        };
      },
    },
    release(stream: StreamTabId): void {
      observer?.(stream);
    },
    hasObserver(): boolean {
      return observer !== undefined;
    },
  };
}

function setupBinder(executionId: string, session?: SessionHandle) {
  const registry = testExecutionRegistry();
  const releaseSource = createReleaseSource();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const binder = new ExecutionSubscriptionBinder({
    registry,
    releaseSource: releaseSource.source,
    logger,
    session,
  });
  registry.track(
    testExecutionHandle({
      executionId,
      parentStreamId: streamId,
      childStreamId,
      agent: 'search',
    }),
  );
  return {
    registry,
    releaseSource,
    logger,
    binder,
    executionId,
    dispose(): void {
      binder.dispose();
      registry.dispose();
    },
  };
}

function setupSessionBinder(executionId: string, attachSession = true) {
  const session = createTestSession();
  const recorded = recordSessionEvents(session.events, { scope: 'session' });
  const bound = setupBinder(executionId, attachSession ? session : undefined);
  return {
    ...bound,
    session,
    recorded,
    dispose(): void {
      recorded.detach();
      bound.dispose();
      session.dispose();
    },
  };
}

const QUEUED_FOLLOW_UPS_EVENT = {
  scope: 'session',
  event: {
    type: 'updateQueuedFollowUps',
    payload: { streamId },
  },
};

async function settleDelivery(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function deliverSubscriptionFollowUp(
  binder: ExecutionSubscriptionBinder,
  registry: ExecutionRegistry,
  executionId: string,
): Promise<void> {
  binder.bind(streamId, executionId);
  registry.untrack(executionId);
  await settleDelivery();
}

describe('ExecutionSubscriptionBinder lifecycle', () => {
  it('owns bind and unbind state per stream/execution pair', () => {
    const { logger, binder, executionId, dispose } = setupBinder(
      'exec-subscription-bind-test',
    );

    try {
      binder.bind(streamId, executionId);
      binder.bind(streamId, executionId);

      expect(binder.unbind(streamId, executionId)).toBe(true);
      expect(binder.unbind(streamId, executionId)).toBe(false);
      expect(logger.info).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it('disposes stream subscriptions when the follow-up queue is released', () => {
    const { releaseSource, binder, executionId, dispose } = setupBinder(
      'exec-subscription-release-test',
    );

    try {
      binder.bind(streamId, executionId);

      releaseSource.release(streamId);

      expect(binder.unbind(streamId, executionId)).toBe(false);
    } finally {
      dispose();
    }
  });

  it('unregisters the release observer when disposed', () => {
    const { releaseSource, binder, executionId, dispose } = setupBinder(
      'exec-subscription-dispose-test',
    );

    try {
      binder.bind(streamId, executionId);

      expect(releaseSource.hasObserver()).toBe(true);
      binder.dispose();

      expect(releaseSource.hasObserver()).toBe(false);
      expect(binder.unbind(streamId, executionId)).toBe(false);
    } finally {
      dispose();
    }
  });
});

describe('ExecutionSubscriptionBinder session routing', () => {
  beforeEach(() => {
    submitFollowUpMock.mockReset();
    submitFollowUpMock.mockResolvedValue({ status: 'sent' as const });
  });

  it('passes the owning session to subscription follow-ups', async () => {
    const { registry, session, recorded, binder, executionId, dispose } =
      setupSessionBinder('exec-subscription-session-test');

    try {
      await deliverSubscriptionFollowUp(binder, registry, executionId);

      expect(submitFollowUpMock).toHaveBeenCalledWith(
        streamId,
        expect.stringContaining(executionId),
        { session, mode: 'live_notification' },
      );
      expect(recorded.events).toEqual([QUEUED_FOLLOW_UPS_EVENT]);
    } finally {
      dispose();
    }
  });

  it.each([
    [{ status: 'sent' as const }, true],
    [{ status: 'queued' as const, reason: 'waiting' as const }, true],
    [{ status: 'no_session' as const, streamStatus: undefined }, false],
  ])(
    'emits the queued-follow-up fact only for delivered follow-ups: %o',
    async (sendResult, shouldEmit) => {
      const { registry, recorded, binder, executionId, dispose } =
        setupSessionBinder(`exec-subscription-${sendResult.status}-event-test`);
      submitFollowUpMock.mockResolvedValueOnce(sendResult);

      try {
        await deliverSubscriptionFollowUp(binder, registry, executionId);

        expect(recorded.events).toEqual(
          shouldEmit ? [QUEUED_FOLLOW_UPS_EVENT] : [],
        );
      } finally {
        dispose();
      }
    },
  );

  it('falls back to the current session when the binder has no explicit session', async () => {
    const { registry, session, recorded, binder, executionId, dispose } =
      setupSessionBinder('exec-subscription-current-session-test', false);

    try {
      withRunContext(createRunContext({ session }), () => {
        binder.bind(streamId, executionId);
        registry.untrack(executionId);
      });
      await settleDelivery();

      expect(recorded.events).toEqual([QUEUED_FOLLOW_UPS_EVENT]);
    } finally {
      dispose();
    }
  });

  it('warns instead of leaking an unhandled rejection when delivery fails', async () => {
    const { registry, recorded, logger, binder, executionId, dispose } =
      setupSessionBinder('exec-subscription-rejection-test');
    const unhandledRejection = vi.fn();
    submitFollowUpMock.mockRejectedValueOnce(new Error('delivery failed'));

    try {
      process.once('unhandledRejection', unhandledRejection);
      await deliverSubscriptionFollowUp(binder, registry, executionId);

      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(recorded.events).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to deliver execution subscription follow-up',
        expect.objectContaining({
          data: expect.objectContaining({ executionId, streamId }),
        }),
      );
    } finally {
      process.off('unhandledRejection', unhandledRejection);
      dispose();
    }
  });
});
