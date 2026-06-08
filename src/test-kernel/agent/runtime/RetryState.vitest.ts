// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - agent runtime
import { noopTrace, type AgentTrace } from '@agent/trace';
import type { NonIterableObject } from '@agent/node';
import { RetryableInvocationNode } from '@agent/core/flows/RetryState';
import {
  StreamStatusRegistry,
  StreamStatusService,
} from '@agent/runtime/StreamStatusService';
import {
  noopAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

const coordinatorMocks = vi.hoisted(() => ({
  waitForRetry: vi.fn(),
}));

vi.mock('@agent/runtime/runCoordinators', () => ({
  runCoordinatorBridge: {
    waitForRetry: coordinatorMocks.waitForRetry,
  },
}));

interface TestRetryServices {
  streamId: StreamTabId;
  runtimeHost: AgentRuntimeHost;
  streamStatus: StreamStatusRegistry;
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

describe('RetryState', () => {
  it('treats user aborts as cancellations instead of failed invocations', () => {
    const node = new ExposedRetryNode();
    const abort = new DOMException('Request aborted', 'AbortError');

    expect(node.shouldAutoRetry(abort)).toBe(false);
    expect(node.fallbackFor(abort)).toEqual({ kind: 'cancelled' });
  });

  it('updates the injected stream status owner during manual retry', async () => {
    const streamId = 'retry-state-owner' as StreamTabId;
    const streamStatus = new StreamStatusRegistry();
    const node = new ExposedRetryNode().setServices({
      streamId,
      runtimeHost: noopAgentRuntimeHost,
      streamStatus,
      logger: noopTrace,
      setAbortController: vi.fn(),
    });

    coordinatorMocks.waitForRetry.mockResolvedValueOnce({ action: 'retry' });

    try {
      streamStatus.set(streamId, STREAM_STATUS.RUNNING, { emit: false });
      StreamStatusService.set(streamId, STREAM_STATUS.STOPPED, {
        emit: false,
      });

      await node.promptFor(new Error('temporary provider failure'));

      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.RUNNING);
      expect(StreamStatusService.get(streamId)).toBe(STREAM_STATUS.STOPPED);
      expect(coordinatorMocks.waitForRetry).toHaveBeenCalledWith(
        streamId,
        expect.objectContaining({
          operation: 'Tool-use call',
        }),
      );
    } finally {
      streamStatus.clear(streamId, { emit: false });
      StreamStatusService.clear(streamId, { emit: false });
      coordinatorMocks.waitForRetry.mockReset();
    }
  });
});
