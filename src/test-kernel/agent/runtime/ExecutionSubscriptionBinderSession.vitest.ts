// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockSendFollowUpResult =
  | { status: 'sent' }
  | { status: 'queued'; reason: 'waiting' }
  | { status: 'no_session'; streamStatus: string | undefined };

const sendFollowUpMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<MockSendFollowUpResult>>(async () => ({
    status: 'sent',
  })),
);

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  sendFollowUp: sendFollowUpMock,
}));

// Local imports
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { ExecutionSubscriptionBinder } from '@agent/runtime/ExecutionSubscriptionBinder';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { StreamTabId } from '@shared/schemas';

// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

// Local file imports
import { createRecordingHost, recordSessionEvents } from '../progressTestUtils';

const streamId = 'stream:subscription-session' as StreamTabId;
const childStreamId = 'child:subscription-session' as StreamTabId;

/** Builds a toolUse `search` handle on the shared stream/child stream. */
function createSearchHandle(
  executionId: string,
  runtimeHost: AgentRuntimeHost,
): AgentExecutionHandle {
  return new AgentExecutionHandle(
    executionId,
    streamId,
    childStreamId,
    'search',
    'toolUse',
    runtimeHost,
  );
}

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

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function setupBinder(executionId: string) {
  const registry = new ExecutionRegistry();
  const releaseSource = createReleaseSource();
  const logger = createLogger();
  const explicit = createRecordingHost();
  const binder = new ExecutionSubscriptionBinder({
    registry,
    releaseSource: releaseSource.source,
    logger,
  });
  registry.track(createSearchHandle(executionId, explicit.host));
  return { registry, releaseSource, logger, binder, executionId };
}

async function settleDelivery(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('ExecutionSubscriptionBinder lifecycle', () => {
  it('owns bind and unbind state per stream/execution pair', () => {
    const { registry, logger, binder, executionId } = setupBinder(
      'exec-subscription-bind-test',
    );

    try {
      binder.bind(streamId, executionId);
      binder.bind(streamId, executionId);

      expect(binder.unbind(streamId, executionId)).toBe(true);
      expect(binder.unbind(streamId, executionId)).toBe(false);
      expect(logger.info).toHaveBeenCalledTimes(1);
    } finally {
      binder.dispose();
      registry.dispose();
    }
  });

  it('disposes stream subscriptions when the follow-up queue is released', () => {
    const { registry, releaseSource, binder, executionId } = setupBinder(
      'exec-subscription-release-test',
    );

    try {
      binder.bind(streamId, executionId);

      releaseSource.release(streamId);

      expect(binder.unbind(streamId, executionId)).toBe(false);
    } finally {
      binder.dispose();
      registry.dispose();
    }
  });

  it('unregisters the release observer when disposed', () => {
    const { registry, releaseSource, binder, executionId } = setupBinder(
      'exec-subscription-dispose-test',
    );

    try {
      binder.bind(streamId, executionId);

      expect(releaseSource.hasObserver()).toBe(true);
      binder.dispose();

      expect(releaseSource.hasObserver()).toBe(false);
      expect(binder.unbind(streamId, executionId)).toBe(false);
    } finally {
      registry.dispose();
    }
  });
});

describe('ExecutionSubscriptionBinder session routing', () => {
  beforeEach(() => {
    sendFollowUpMock.mockReset();
    sendFollowUpMock.mockResolvedValue({ status: 'sent' as const });
  });

  it('passes the owning session to subscription follow-ups', async () => {
    const registry = new ExecutionRegistry();
    const session = createTestSession();
    const recorded = recordSessionEvents(session.events, { scope: 'session' });
    const explicit = createRecordingHost();
    const binder = new ExecutionSubscriptionBinder({
      registry,
      releaseSource: createReleaseSource().source,
      logger: createLogger(),
      session,
    });
    const executionId = 'exec-subscription-session-test';
    const handle = createSearchHandle(executionId, explicit.host);

    try {
      registry.track(handle);
      binder.bind(streamId, executionId);

      registry.untrack(executionId);
      await settleDelivery();

      expect(sendFollowUpMock).toHaveBeenCalledWith(
        streamId,
        expect.stringContaining(executionId),
        undefined,
        undefined,
        session,
      );
      expect(recorded.events).toEqual([
        {
          scope: 'session',
          event: {
            type: 'updateQueuedFollowUps',
            payload: { streamId },
          },
        },
      ]);
    } finally {
      recorded.detach();
      binder.dispose();
      registry.dispose();
      session.dispose();
    }
  });

  it.each([
    [{ status: 'sent' as const }, true],
    [{ status: 'queued' as const, reason: 'waiting' as const }, true],
    [{ status: 'no_session' as const, streamStatus: undefined }, false],
  ])(
    'emits the queued-follow-up fact only for delivered follow-ups: %o',
    async (sendResult, shouldEmit) => {
      const registry = new ExecutionRegistry();
      const session = createTestSession();
      const recorded = recordSessionEvents(session.events, {
        scope: 'session',
      });
      const explicit = createRecordingHost();
      const binder = new ExecutionSubscriptionBinder({
        registry,
        releaseSource: createReleaseSource().source,
        logger: createLogger(),
        session,
      });
      const executionId = `exec-subscription-${sendResult.status}-event-test`;
      const handle = createSearchHandle(executionId, explicit.host);
      sendFollowUpMock.mockResolvedValueOnce(sendResult);

      try {
        registry.track(handle);
        binder.bind(streamId, executionId);

        registry.untrack(executionId);
        await settleDelivery();

        expect(recorded.events).toEqual(
          shouldEmit
            ? [
                {
                  scope: 'session',
                  event: {
                    type: 'updateQueuedFollowUps',
                    payload: { streamId },
                  },
                },
              ]
            : [],
        );
      } finally {
        recorded.detach();
        binder.dispose();
        registry.dispose();
        session.dispose();
      }
    },
  );

  it('falls back to the current session when the binder has no explicit session', async () => {
    const registry = new ExecutionRegistry();
    const session = createTestSession();
    const recorded = recordSessionEvents(session.events, { scope: 'session' });
    const explicit = createRecordingHost();
    const binder = new ExecutionSubscriptionBinder({
      registry,
      releaseSource: createReleaseSource().source,
      logger: createLogger(),
    });
    const executionId = 'exec-subscription-current-session-test';
    const handle = createSearchHandle(executionId, explicit.host);

    try {
      registry.track(handle);
      withRunContext(
        createRunContext({
          runtimeHost: explicit.host,
          session,
        }),
        () => {
          binder.bind(streamId, executionId);
          registry.untrack(executionId);
        },
      );
      await settleDelivery();

      expect(recorded.events).toEqual([
        {
          scope: 'session',
          event: {
            type: 'updateQueuedFollowUps',
            payload: { streamId },
          },
        },
      ]);
    } finally {
      recorded.detach();
      binder.dispose();
      registry.dispose();
      session.dispose();
    }
  });

  it('warns instead of leaking an unhandled rejection when delivery fails', async () => {
    const registry = new ExecutionRegistry();
    const explicit = createRecordingHost();
    const logger = createLogger();
    const session = createTestSession();
    const recorded = recordSessionEvents(session.events, { scope: 'session' });
    const binder = new ExecutionSubscriptionBinder({
      registry,
      releaseSource: createReleaseSource().source,
      logger,
      session,
    });
    const executionId = 'exec-subscription-rejection-test';
    const handle = createSearchHandle(executionId, explicit.host);
    const unhandledRejection = vi.fn();
    sendFollowUpMock.mockRejectedValueOnce(new Error('delivery failed'));

    try {
      process.once('unhandledRejection', unhandledRejection);
      registry.track(handle);
      binder.bind(streamId, executionId);

      registry.untrack(executionId);
      await settleDelivery();

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
      recorded.detach();
      binder.dispose();
      registry.dispose();
      session.dispose();
    }
  });
});
