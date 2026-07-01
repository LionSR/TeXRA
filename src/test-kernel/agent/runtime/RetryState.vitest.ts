// Third-party imports
import { describe, expect, it, vi, type Mock } from 'vitest';

// Local imports - agent runtime
import { noopTrace, type AgentTrace } from '@agent/trace';
import type { NonIterableObject } from '@agent/node';
import type { BaseCycleFields } from '@agent/core/flows/CommonCycleTypes';
import { ModelInvocationNode } from '@agent/core/flows/ModelInvocationNode';
import { RetryableInvocationNode } from '@agent/core/flows/RetryState';
import type { RetryResult } from '@agent/runtime/RetryRequestCoordinator';
import {
  StreamStatusRegistry,
  StreamStatusService,
} from '@agent/runtime/StreamStatusService';
import {
  noopAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { attachFlowAutoRetryRequired } from '@common/errors/sdkErrorUtils';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

interface TestRetryServices {
  streamId: StreamTabId;
  runtimeHost: AgentRuntimeHost;
  streamStatus: StreamStatusRegistry;
  logger: AgentTrace;
  setAbortController: (ac: AbortController | null) => void;
  waitForRetry: (
    streamId: string,
    options: { operation: string; errorMessage?: string; logger: AgentTrace },
  ) => Promise<RetryResult>;
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
  streamStatus: StreamStatusRegistry;
  waitForRetry: Mock<TestRetryServices['waitForRetry']>;
}

function createRetryNode(streamId: StreamTabId): RetryNodeKit {
  const streamStatus = new StreamStatusRegistry();
  const waitForRetry = vi.fn<TestRetryServices['waitForRetry']>();
  const node = new ExposedRetryNode().setServices({
    streamId,
    runtimeHost: noopAgentRuntimeHost,
    streamStatus,
    logger: noopTrace,
    setAbortController: vi.fn(),
    waitForRetry,
  });
  return { node, streamStatus, waitForRetry };
}

function createModelInvocationNode(input: {
  usesProviderManagedAutoRetry: boolean;
  isAutoRetryManagedByProvider?: (error: Error) => boolean;
}): ModelInvocationNode<BaseCycleFields> {
  return new ModelInvocationNode<BaseCycleFields>({
    operationName: 'Model call',
    streaming: false,
    storeResponse: vi.fn(),
  }).setServices({
    modelHandler: {
      usesProviderManagedAutoRetry: input.usesProviderManagedAutoRetry,
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
      usesProviderManagedAutoRetry: true,
    });

    expect(node.shouldAutoRetry(new Error('temporary provider failure'))).toBe(
      false,
    );
  });

  it('keeps flow-level auto-retry for errors outside the provider retry boundary', () => {
    const node = createModelInvocationNode({
      usesProviderManagedAutoRetry: true,
    });
    const streamError = new Error('stream closed after response started');

    attachFlowAutoRetryRequired(streamError);

    expect(node.shouldAutoRetry(streamError)).toBe(true);
  });

  it('keeps flow-level auto-retry when the handler predicate excludes an error', () => {
    const node = createModelInvocationNode({
      usesProviderManagedAutoRetry: true,
      isAutoRetryManagedByProvider: () => false,
    });

    expect(node.shouldAutoRetry(new Error('rate limit'))).toBe(true);
  });

  it('uses flow-level auto-retry when the model handler has no provider-managed retry', () => {
    const node = createModelInvocationNode({
      usesProviderManagedAutoRetry: false,
    });

    expect(node.shouldAutoRetry(new Error('temporary provider failure'))).toBe(
      true,
    );
  });

  it('updates the injected stream status owner during manual retry', async () => {
    const streamId = 'retry-state-owner' as StreamTabId;
    const { node, streamStatus, waitForRetry } = createRetryNode(streamId);

    waitForRetry.mockResolvedValueOnce({ action: 'retry' });

    try {
      streamStatus.set(streamId, STREAM_STATUS.RUNNING, { emit: false });
      StreamStatusService.set(streamId, STREAM_STATUS.STOPPED, {
        emit: false,
      });

      await node.promptFor(new Error('temporary provider failure'));

      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.RUNNING);
      expect(StreamStatusService.get(streamId)).toBe(STREAM_STATUS.STOPPED);
      expect(waitForRetry).toHaveBeenCalledWith(
        streamId,
        expect.objectContaining({
          operation: 'Tool-use call',
        }),
      );
    } finally {
      streamStatus.clear(streamId, { emit: false });
      StreamStatusService.clear(streamId, { emit: false });
    }
  });

  it.each(['cancel', 'timeout'] as const)(
    'stops the stream after manual retry %s',
    async (action) => {
      const streamId = `retry-state-${action}` as StreamTabId;
      const { node, streamStatus, waitForRetry } = createRetryNode(streamId);

      waitForRetry.mockResolvedValueOnce({ action });

      try {
        streamStatus.set(streamId, STREAM_STATUS.RUNNING, { emit: false });

        await node.promptFor(new Error('temporary provider failure'));

        expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.STOPPED);
      } finally {
        streamStatus.clear(streamId, { emit: false });
      }
    },
  );
});
