// Test composition imports

// Local imports
import '@test/support/defaultSessionTestSetup';

// Test support imports

// Third-party imports
import { APIError as OpenAIAPIError } from 'openai';
import { describe, expect, it, vi, type Mock } from 'vitest';

// Local imports
import { noopTrace, type AgentTrace } from '@agent/trace';
import type { BaseCycleFields } from '@agent/core/flows/CommonCycleTypes';
import { ModelInvocationNode } from '@agent/core/flows/ModelInvocationNode';
import {
  RetryableInvocationNode,
  handleInvocationResult,
} from '@agent/core/flows/RetryState';
import { tagOpenAISdkError } from '@agent/modelHandlers/openai/openAISdkError';
import type {
  HostRetryInteractionOptions,
  HostRetryRequest,
  RetryResult,
} from '@agent/runtime/HostInteractions';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  noopAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import {
  attachContextWindowError,
  attachFlowAutoRetryRequired,
} from '@common/errors/sdkErrorUtils';
import {
  STREAM_PHASE,
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { DEFAULT_CORE_SETTINGS } from '@shared/schemas/coreSettings';
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/helpers/streamStatusTestUtils';
import { createTestSession } from '@test/support/sessionTestUtils';

// Local file imports
import {
  createRecordingHost,
  sessionWithInteractions,
} from '../progressTestUtils';

interface TestRetryServices {
  config: { model: string };
  streamId: StreamTabId;
  runtimeHost: AgentRuntimeHost;
  logger: AgentTrace;
  setAbortController: (ac: AbortController | null) => void;
  refreshClient?: () => Promise<void>;
}

class ExposedRetryNode extends RetryableInvocationNode<
  unknown,
  TestRetryServices
> {
  protected getOperationName(): string {
    return 'Model request';
  }

  promptFor(error: Error): Promise<unknown> {
    return this.handleManualRetryPrompt(error);
  }

  fallbackFor(error: Error): unknown {
    return this.getFallbackResult(error);
  }

  seedPersistent401Guards(): void {
    this._persistent401Error = new Error('persistent relay 401');
    this._hasAttemptedTokenRefresh = true;
  }

  persistent401Guards(): {
    readonly error: Error | null;
    readonly tokenRefreshAttempted: boolean;
  } {
    return {
      error: this._persistent401Error,
      tokenRefreshAttempted: this._hasAttemptedTokenRefresh,
    };
  }
}

interface RetryNodeKit {
  node: ExposedRetryNode;
  session: SessionHandle;
  streamStatus: StreamStatusMachine;
  requestRetry: Mock<
    (
      request: HostRetryRequest,
      options?: HostRetryInteractionOptions,
    ) => Promise<RetryResult>
  >;
}

function createRetryNode(
  streamId: StreamTabId,
  refreshClient?: () => Promise<void>,
): RetryNodeKit {
  const streamStatus = new StreamStatusMachine();
  const requestRetry = vi.fn<RetryNodeKit['requestRetry']>();
  const session = sessionWithInteractions(
    { requestRetry, cancel: () => {} },
    streamStatus,
  );
  const node = new ExposedRetryNode().setServices({
    config: { model: 'copilot:sonnet46' },
    streamId,
    runtimeHost: noopAgentRuntimeHost,
    logger: noopTrace,
    setAbortController: vi.fn(),
    refreshClient,
  });
  return { node, session, streamStatus, requestRetry };
}

async function withRetryRunContext<T>(
  streamId: StreamTabId,
  session: SessionHandle,
  fn: () => T | Promise<T>,
): Promise<T> {
  const context = createRunContext({
    modelSource: 'live',
    getModel: () => undefined,
    runScope: createRunScope({
      runtimeHost: noopAgentRuntimeHost,
      streamId,
      executionId: `${streamId}-execution` as ExecutionId,
      agentName: 'retry-test',
      session,
    }),
  });
  return await withRunContext(context, fn);
}

async function withSessionRetryRunContext<T>(
  streamId: StreamTabId,
  session: SessionHandle,
  runtimeHost: AgentRuntimeHost,
  fn: () => T | Promise<T>,
): Promise<T> {
  const context = createRunContext({
    modelSource: 'live',
    getModel: () => undefined,
    runScope: createRunScope({
      runtimeHost,
      streamId,
      executionId: `${streamId}-execution` as ExecutionId,
      agentName: 'retry-test',
      session,
    }),
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
  it('records whether a failed invocation already emitted its canonical error', () => {
    const state: BaseCycleFields = {
      messages: [],
      shouldStop: false,
      endTurn: true,
    };

    const result = handleInvocationResult(
      {
        kind: 'failed',
        message: 'HTTP 503 Service Unavailable',
        userRetryable: true,
        failureLogEmitted: true,
      },
      state,
      { logger: noopTrace, operationName: 'Model request' },
    );

    expect(result).toBeNull();
    expect(state.lastError).toEqual({
      message: 'HTTP 503 Service Unavailable',
      userRetryable: true,
    });
    expect(state.failureLogEmitted).toBe(true);
  });

  it('leaves an empty model response available for the outer error logger', () => {
    const state: BaseCycleFields = {
      messages: [],
      shouldStop: false,
      endTurn: true,
    };

    const result = handleInvocationResult(
      { kind: 'success', response: undefined },
      state,
      { logger: noopTrace, operationName: 'Model request' },
    );

    expect(result).toBeNull();
    expect(state.lastError?.message).toContain('Model response was empty');
    expect(state.failureLogEmitted).toBe(false);
  });

  it('falls back to the canonical coreSettings default when texra.model.retry.maxAttempts is unset', () => {
    const node = new ExposedRetryNode();

    // Node.maxRetries counts the initial attempt plus auto-retries, so an
    // unset config value should resolve to 1 + the coreSettings default.
    expect(node.maxRetries).toBe(
      1 + DEFAULT_CORE_SETTINGS.model.retry.maxAttempts,
    );
  });

  it('treats user aborts as cancellations instead of failed invocations', () => {
    const node = new ExposedRetryNode();
    const abort = new DOMException('Request aborted', 'AbortError');

    expect(node.shouldAutoRetry(abort)).toBe(false);
    expect(node.fallbackFor(abort)).toEqual({ kind: 'cancelled' });
  });

  it('does not claim an unprompted retryable fallback was already logged', () => {
    const node = new ExposedRetryNode();
    const error = new OpenAIAPIError(
      503,
      { message: 'transient provider failure' },
      'transient provider failure',
      undefined,
    );
    tagOpenAISdkError(error, 'openai');

    expect(node.fallbackFor(error)).toMatchObject({
      kind: 'failed',
      message: 'HTTP 503 Service Unavailable – 503 transient provider failure',
      userRetryable: true,
      failureLogEmitted: false,
    });
  });

  it('auto-retries a status-less OpenAI server_error response', () => {
    const node = new ExposedRetryNode();
    const body = {
      type: 'server_error',
      code: 'server_error',
      message:
        'An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 988f71d8-3453-46f1-a466-529d2a967244 in your message.',
      param: null,
    };
    const error = new OpenAIAPIError(undefined, body, body.message, undefined);
    tagOpenAISdkError(error, 'openai');

    expect(node.shouldAutoRetry(error)).toBe(true);
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

  it('keeps flow-level auto-retry for a raw undici fetch failure', () => {
    const node = createModelInvocationNode({
      isAutoRetryManagedByProvider: () => true,
    });
    const transportError = Object.assign(
      new Error('HTTP/2: "stream timeout after 300000"'),
      { code: 'UND_ERR_INFO', name: 'InformationalError' },
    );
    const fetchError = new TypeError('fetch failed', {
      cause: transportError,
    });

    expect(node.shouldAutoRetry(fetchError)).toBe(true);
  });

  it('does not duplicate provider retries for a wrapped fetch failure', () => {
    const node = createModelInvocationNode({
      isAutoRetryManagedByProvider: () => true,
    });
    const fetchError = new TypeError('fetch failed');
    const sdkError = new Error('Connection error', { cause: fetchError });

    expect(node.shouldAutoRetry(sdkError)).toBe(false);
  });

  it('keeps flow-level auto-retry when the handler predicate excludes an error', () => {
    const node = createModelInvocationNode({
      isAutoRetryManagedByProvider: () => false,
    });

    expect(node.shouldAutoRetry(new Error('rate limit'))).toBe(true);
  });

  it('never auto-retries a context-window overflow, even one tagged flow-auto-retry-required', () => {
    // Regression for the retry storm where a context-window overflow that
    // slipped past provider-specific compaction recovery (e.g. no
    // previous_response_id to chain from) was flattened into a plain,
    // code-free Error and unconditionally tagged attachFlowAutoRetryRequired
    // by the WebSocket transport before classification ran — so it looked
    // identical to a genuinely transient failure and got auto-retried with
    // the exact same oversized payload forever. The base shouldAutoRetry gate
    // must refuse a context-window error unconditionally, regardless of any
    // flow-auto-retry tag, so unrecovered overflows fail once instead of
    // storming.
    const node = createModelInvocationNode({
      isAutoRetryManagedByProvider: () => false,
    });
    const overflow = new Error('OpenAI WebSocket response failed: overflow');
    attachContextWindowError(overflow);
    attachFlowAutoRetryRequired(overflow);

    expect(node.shouldAutoRetry(overflow)).toBe(false);
  });

  it('updates the run session status during manual retry', async () => {
    const streamId = 'retry-state-owner' as StreamTabId;
    const { node, session, streamStatus, requestRetry } =
      createRetryNode(streamId);

    requestRetry.mockResolvedValueOnce({ action: 'retry' });

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_STATUS.RUNNING);

      await withRetryRunContext(streamId, session, () =>
        node.promptFor(new Error('temporary provider failure')),
      );

      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.RUNNING);
      expect(requestRetry).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId,
          operation: 'Model request',
          model: 'copilot:sonnet46',
        }),
        undefined,
      );
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('lets the host prepare a replacement client without refreshing it twice', async () => {
    const streamId = 'retry-state-prepared-client' as StreamTabId;
    const refreshClient = vi.fn(async () => undefined);
    const { node, session, streamStatus, requestRetry } = createRetryNode(
      streamId,
      refreshClient,
    );
    requestRetry.mockImplementationOnce(async (_request, options) => {
      await options?.prepareRetry?.('configured');
      return { action: 'retry' };
    });
    node.seedPersistent401Guards();

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_STATUS.RUNNING);

      await expect(
        withRetryRunContext(streamId, session, () =>
          node.retryPrompt(undefined, new Error('temporary provider failure')),
        ),
      ).resolves.toBe(true);

      expect(refreshClient).toHaveBeenCalledOnce();
      expect(node.persistent401Guards()).toEqual({
        error: null,
        tokenRefreshAttempted: false,
      });
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('resolves manual retries through the session host interactions', async () => {
    const streamId = 'retry-state-session-bridge' as StreamTabId;
    const session = createTestSession();
    const recording = createRecordingHost();
    session.useHostInteractions(recording.interactions);
    const { node } = createRetryNode(streamId);
    const streamStatus = session.status;

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_STATUS.RUNNING);

      const prompt = withSessionRetryRunContext(
        streamId,
        session,
        recording.host,
        () => node.promptFor(new Error('temporary provider failure')),
      );

      expect(
        recording.decisions.submitRetry(streamId, {
          action: 'retry',
          feedback: 'try again',
        }),
      ).toBe(true);

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
      const { node, session, streamStatus, requestRetry } =
        createRetryNode(streamId);

      requestRetry.mockResolvedValueOnce({ action });

      try {
        seedStreamStatusForTest(streamStatus, streamId, STREAM_STATUS.RUNNING);

        await withRetryRunContext(streamId, session, () =>
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
    const { node, session, streamStatus, requestRetry } =
      createRetryNode(streamId);

    requestRetry.mockResolvedValueOnce({
      action: 'deny',
      reason: 'Denied by CLI approval policy.',
    });
    const error = new Error('stream dropped before first token');

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_STATUS.RUNNING);

      const shouldRetry = await withRetryRunContext(streamId, session, () =>
        node.retryPrompt(undefined, error),
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
        failureLogEmitted: true,
      });
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });
});
