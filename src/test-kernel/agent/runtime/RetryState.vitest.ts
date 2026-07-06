// Third-party imports
import { describe, expect, it, vi, type Mock } from 'vitest';

// Local imports - agent runtime
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/helpers/streamStatusTestUtils';
import { noopTrace, type AgentTrace } from '@agent/trace';
import type { NonIterableObject } from '@agent/node';
import type { BaseCycleFields } from '@agent/core/flows/CommonCycleTypes';
import { ModelInvocationNode } from '@agent/core/flows/ModelInvocationNode';
import { RetryableInvocationNode } from '@agent/core/flows/RetryState';
import {
  RetryRequestCoordinatorImpl,
  type RetryResult,
} from '@agent/runtime/RetryRequestCoordinator';
import {
  createRunContext,
  withRunContext,
  type RunCoordinators,
} from '@agent/runtime/RunContext';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  StreamStatusMachine,
  StreamStatusService,
} from '@agent/runtime/StreamStatusService';
import {
  noopAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { attachFlowAutoRetryRequired } from '@common/errors/sdkErrorUtils';
import {
  STREAM_PHASE,
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { createRecordingHost } from '../progressTestUtils';

interface TestRetryServices {
  streamId: StreamTabId;
  runtimeHost: AgentRuntimeHost;
  streamStatus: StreamStatusMachine;
  logger: AgentTrace;
  setAbortController: (ac: AbortController | null) => void;
}

class ExposedRetryNode extends RetryableInvocationNode<
  unknown,
  NonIterableObject,
  TestRetryServices
> {
  protected getOperationName(): string {
    return 'Tool-use call';
  }

  promptFor(error: Error): Promise<unknown> {
    return this.handleManualRetryPrompt(error);
  }

  fallbackFor(error: Error): unknown {
    return this.getFallbackResult(error);
  }
}

interface RetryNodeKit {
  node: ExposedRetryNode;
  streamStatus: StreamStatusMachine;
  waitForRetry: Mock<
    (
      streamId: string,
      options: { operation: string; errorMessage?: string; logger: AgentTrace },
    ) => Promise<RetryResult>
  >;
}

function createRetryNode(streamId: StreamTabId): RetryNodeKit {
  const streamStatus = new StreamStatusMachine();
  const waitForRetry = vi.fn<RetryNodeKit['waitForRetry']>();
  const node = new ExposedRetryNode().setServices({
    streamId,
    runtimeHost: noopAgentRuntimeHost,
    streamStatus,
    logger: noopTrace,
    setAbortController: vi.fn(),
  });
  return { node, streamStatus, waitForRetry };
}

async function withRetryRunContext<T>(
  streamId: StreamTabId,
  waitForRetry: RetryNodeKit['waitForRetry'],
  fn: () => T | Promise<T>,
): Promise<T> {
  const coordinators: RunCoordinators = {
    plan: {} as RunCoordinators['plan'],
    proposal: {} as RunCoordinators['proposal'],
    retry: { waitForRetry } as unknown as RunCoordinators['retry'],
  };
  const context = createRunContext({
    modelSource: 'live',
    getModel: () => undefined,
    runtimeHost: noopAgentRuntimeHost,
    streamId,
    executionId: `${streamId}-execution` as ExecutionId,
    agentName: 'retry-test',
    session: new SessionHandle(),
    coordinators,
  });
  return await withRunContext(context, fn);
}

async function withSessionRetryRunContext<T>(
  streamId: StreamTabId,
  session: SessionHandle,
  runtimeHost: AgentRuntimeHost,
  retry: RetryRequestCoordinatorImpl,
  fn: () => T | Promise<T>,
): Promise<T> {
  const coordinators: RunCoordinators = {
    plan: {} as RunCoordinators['plan'],
    proposal: {} as RunCoordinators['proposal'],
    retry,
  };
  const context = createRunContext({
    modelSource: 'live',
    getModel: () => undefined,
    runtimeHost,
    streamId,
    executionId: `${streamId}-execution` as ExecutionId,
    agentName: 'retry-test',
    session,
    coordinators,
  });
  return await withRunContext(context, fn);
}

function createModelInvocationNode(input: {
  isAutoRetryManagedByProvider: (error: Error) => boolean;
}): ModelInvocationNode<BaseCycleFields> {
  return new ModelInvocationNode<BaseCycleFields>({
    operationName: 'Model call',
    streaming: false,
    storeResponse: vi.fn(),
  }).setServices({
    modelHandler: {
      isAutoRetryManagedByProvider: input.isAutoRetryManagedByProvider,
      isBackgroundModeActive: () => false,
    },
    logger: noopTrace,
  } as never);
}

describe('RetryState', () => {
  it('treats user aborts as cancellations instead of failed invocations', () => {
    const node = new ExposedRetryNode();
    const abort = new DOMException('Request aborted', 'AbortError');

    expect(node.shouldAutoRetry(abort)).toBe(false);
    expect(node.fallbackFor(abort)).toEqual({ kind: 'cancelled' });
  });

  it('skips flow-level auto-retry when the model handler delegates retries to the provider', () => {
    const node = createModelInvocationNode({
      isAutoRetryManagedByProvider: () => true,
    });

    expect(node.shouldAutoRetry(new Error('temporary provider failure'))).toBe(
      false,
    );
  });

  it('keeps flow-level auto-retry for errors outside the provider retry boundary', () => {
    const node = createModelInvocationNode({
      isAutoRetryManagedByProvider: () => true,
    });
    const streamError = new Error('stream closed after response started');

    attachFlowAutoRetryRequired(streamError);

    expect(node.shouldAutoRetry(streamError)).toBe(true);
  });

  it('keeps flow-level auto-retry when the handler predicate excludes an error', () => {
    const node = createModelInvocationNode({
      isAutoRetryManagedByProvider: () => false,
    });

    expect(node.shouldAutoRetry(new Error('rate limit'))).toBe(true);
  });

  it('updates the injected stream status owner during manual retry', async () => {
    const streamId = 'retry-state-owner' as StreamTabId;
    const { node, streamStatus, waitForRetry } = createRetryNode(streamId);

    waitForRetry.mockResolvedValueOnce({ action: 'retry' });

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_STATUS.RUNNING);
      seedStreamStatusForTest(
        StreamStatusService,
        streamId,
        STREAM_PHASE.CANCELLED,
      );

      await withRetryRunContext(streamId, waitForRetry, () =>
        node.promptFor(new Error('temporary provider failure')),
      );

      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.RUNNING);
      expect(StreamStatusService.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(waitForRetry).toHaveBeenCalledWith(
        streamId,
        expect.objectContaining({
          operation: 'Tool-use call',
        }),
      );
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
      clearStreamStatusForTest(StreamStatusService, streamId);
    }
  });

  it('registers manual retries on the session coordinator bridge', async () => {
    const streamId = 'retry-state-session-bridge' as StreamTabId;
    const session = new SessionHandle();
    const { host } = createRecordingHost();
    const retry = new RetryRequestCoordinatorImpl(host);
    const { node, streamStatus } = createRetryNode(streamId);

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_STATUS.RUNNING);

      const prompt = withSessionRetryRunContext(
        streamId,
        session,
        host,
        retry,
        () => node.promptFor(new Error('temporary provider failure')),
      );

      expect(session.coordinators.triggerRetry(streamId, 'try again')).toBe(
        true,
      );

      await expect(prompt).resolves.toMatchObject({
        shouldRetry: true,
        userCancelled: false,
      });
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.RUNNING);
    } finally {
      session.dispose();
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it.each(['cancel', 'timeout'] as const)(
    'stops the stream after manual retry %s',
    async (action) => {
      const streamId = `retry-state-${action}` as StreamTabId;
      const { node, streamStatus, waitForRetry } = createRetryNode(streamId);

      waitForRetry.mockResolvedValueOnce({ action });

      try {
        seedStreamStatusForTest(streamStatus, streamId, STREAM_STATUS.RUNNING);

        await withRetryRunContext(streamId, waitForRetry, () =>
          node.promptFor(new Error('temporary provider failure')),
        );

        expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
      } finally {
        clearStreamStatusForTest(streamStatus, streamId);
      }
    },
  );

  it('classifies a policy/headless retry denial as failed, not cancelled (#7331)', async () => {
    const streamId = 'retry-state-deny' as StreamTabId;
    const { node, streamStatus, waitForRetry } = createRetryNode(streamId);

    waitForRetry.mockResolvedValueOnce({
      action: 'deny',
      reason: 'Denied by CLI approval policy.',
    });
    const error = new Error('stream dropped before first token');

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_STATUS.RUNNING);

      const shouldRetry = await withRetryRunContext(
        streamId,
        waitForRetry,
        () => node.retryPrompt(undefined, error),
      );

      // A denial does not retry and — crucially — is NOT a user cancel, so the
      // stream resumes to RUNNING to let the failure terminalize (a WAITING
      // stream can't be written to a terminal outcome directly).
      expect(shouldRetry).toBe(false);
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.RUNNING);

      // The fallback classifies this as `failed` (→ RUN_OUTCOME.FAILED),
      // surfacing the underlying error — rather than `cancelled`, which would
      // let a zero-output run report COMPLETED.
      expect(node.fallbackFor(error)).toMatchObject({
        kind: 'failed',
        message: 'stream dropped before first token',
      });
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });
});
