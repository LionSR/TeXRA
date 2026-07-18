// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

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

// Local imports - runtime
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { ExecutionSubscriptionBinder } from '@agent/runtime/ExecutionSubscriptionBinder';
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';

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
  return {
    onRelease(): () => void {
      return () => {};
    },
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

async function settleDelivery(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

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
      releaseSource: createReleaseSource(),
      logger: createLogger(),
      session,
    });
    const executionId = 'exec-subscription-session-test';
    const handle = createSearchHandle(executionId, explicit.host);

    try {
      registry.track(handle);
      binder.bind(streamId, executionId, explicit.host);

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
        releaseSource: createReleaseSource(),
        logger: createLogger(),
        session,
      });
      const executionId = `exec-subscription-${sendResult.status}-event-test`;
      const handle = createSearchHandle(executionId, explicit.host);
      sendFollowUpMock.mockResolvedValueOnce(sendResult);

      try {
        registry.track(handle);
        binder.bind(streamId, executionId, explicit.host);

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
      releaseSource: createReleaseSource(),
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
          binder.bind(streamId, executionId, explicit.host);
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
      releaseSource: createReleaseSource(),
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
      binder.bind(streamId, executionId, explicit.host);

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
