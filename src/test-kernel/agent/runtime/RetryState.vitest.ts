// Test composition imports

// Local imports
import '@test/support/defaultSessionTestSetup';

// Test support imports

// Third-party imports
import { APIError as OpenAIAPIError } from 'openai';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

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
import type { ModelCredentialRoute } from '@agent/types/ModelHandlerContracts';
import {
  RELAY_CI_TOKEN_PREFIX,
  RELAY_TOKEN_ENV_VAR,
  resetRelayTokenTierCacheForTests,
} from '@auth/relayToken';
import { SupabaseClient } from '@auth/SupabaseClient';
import type { AuthTokenProvider } from '@auth/TokenProvider';
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
  clientCredentialRoute?: ModelCredentialRoute;
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

  runWithAbort<T>(op: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.withAbortController(op);
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
  clientCredentialRoute?: ModelCredentialRoute,
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
    clientCredentialRoute,
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

function createModelInvocationNode(): ModelInvocationNode<BaseCycleFields> {
  return new ModelInvocationNode<BaseCycleFields>({
    operationName: 'Model call',
    streaming: false,
    storeResponse: vi.fn(),
  }).setServices({
    modelHandler: {
      isBackgroundModeActive: () => false,
    },
    logger: noopTrace,
  } as never);
}

function createAuthTokenProvider(
  overrides: Partial<AuthTokenProvider> = {},
): AuthTokenProvider {
  return {
    whenReady: async () => {},
    ensureFreshToken: async () => 'access-token',
    getSessionTokens: async () => null,
    ...overrides,
  };
}

describe('RetryState', () => {
  beforeEach(() => {
    vi.stubEnv(RELAY_TOKEN_ENV_VAR, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRelayTokenTierCacheForTests();
    SupabaseClient.resetForTests();
  });

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

  it('falls back to the canonical retry count and delay when settings are unset', () => {
    const node = new ExposedRetryNode();

    // Node.maxRetries counts the initial attempt plus auto-retries, so an
    // unset config value should resolve to 1 + the coreSettings default.
    expect(node.maxRetries).toBe(
      1 + DEFAULT_CORE_SETTINGS.model.retry.maxAttempts,
    );
    expect(node.wait).toBe(DEFAULT_CORE_SETTINGS.model.retry.backoffMs / 1000);
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

  it('delays an unclassified retryable failure before the next attempt', async () => {
    class StatuslessServerErrorNode extends ExposedRetryNode {
      attempts = 0;

      override async exec(): Promise<string> {
        this.attempts += 1;
        if (this.attempts > 1) return 'recovered';

        const body = {
          type: 'server_error',
          code: 'server_error',
          message: 'temporary provider failure',
        };
        const error = new OpenAIAPIError(
          undefined,
          body,
          body.message,
          undefined,
        );
        tagOpenAISdkError(error, 'openai');
        throw error;
      }
    }

    vi.useFakeTimers();
    try {
      const node = new StatuslessServerErrorNode().setServices({
        config: { model: 'openai:test' },
        streamId: 'retry-delay' as StreamTabId,
        runtimeHost: noopAgentRuntimeHost,
        logger: noopTrace,
        setAbortController: vi.fn(),
      });
      const retry = node._exec(undefined);
      const delayMs = DEFAULT_CORE_SETTINGS.model.retry.backoffMs;

      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(node.attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(retry).resolves.toBe('recovered');
      expect(node.attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps interruption active throughout the automatic retry delay', async () => {
    class InterruptibleBackoffNode extends ExposedRetryNode {
      attempts = 0;

      override async exec(): Promise<never> {
        this.attempts += 1;
        throw Object.assign(new Error('temporary provider failure'), {
          status: 503,
        });
      }

      override async execFallback(
        _prepRes: unknown,
        error: Error,
      ): Promise<unknown> {
        return this.fallbackFor(error);
      }
    }

    vi.useFakeTimers();
    try {
      const activeController: { current: AbortController | null } = {
        current: null,
      };
      const node = new InterruptibleBackoffNode().setServices({
        config: { model: 'openai:test' },
        streamId: 'retry-interrupt' as StreamTabId,
        runtimeHost: noopAgentRuntimeHost,
        logger: noopTrace,
        setAbortController: (controller) => {
          activeController.current = controller;
        },
      });
      const retry = node._exec(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(node.attempts).toBe(1);

      activeController.current?.abort(
        new DOMException('Run interrupted', 'AbortError'),
      );
      await expect(retry).resolves.toEqual({ kind: 'cancelled' });
      expect(node.attempts).toBe(1);
      expect(activeController.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-retries an HTTP conflict after provider SDK retries are disabled', () => {
    const node = new ExposedRetryNode();
    const error = Object.assign(new Error('request lock is still held'), {
      status: 409,
    });

    expect(node.shouldAutoRetry(error)).toBe(true);
  });

  it('does not prompt for a manual retry after cancellation', async () => {
    const streamId = 'retry-cancelled' as StreamTabId;
    const { node, requestRetry } = createRetryNode(streamId);

    await expect(
      node.retryPrompt(
        undefined,
        new DOMException('Model retry gate disposed', 'AbortError'),
      ),
    ).resolves.toBe(false);
    expect(requestRetry).not.toHaveBeenCalled();
  });

  it('keeps node-level auto-retry for transient stream failures', () => {
    const node = createModelInvocationNode();
    const streamError = new Error('stream closed after response started');

    attachFlowAutoRetryRequired(streamError);

    expect(node.shouldAutoRetry(streamError)).toBe(true);
  });

  it('keeps flow-level auto-retry for a raw undici fetch failure', () => {
    const node = createModelInvocationNode();
    const transportError = Object.assign(
      new Error('HTTP/2: "stream timeout after 300000"'),
      { code: 'UND_ERR_INFO', name: 'InformationalError' },
    );
    const fetchError = new TypeError('fetch failed', {
      cause: transportError,
    });

    expect(node.shouldAutoRetry(fetchError)).toBe(true);
  });

  it('owns retrying a wrapped provider fetch failure', () => {
    const node = createModelInvocationNode();
    const fetchError = new TypeError('fetch failed');
    const sdkError = new Error('Connection error', { cause: fetchError });

    expect(node.shouldAutoRetry(sdkError)).toBe(true);
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
    const node = createModelInvocationNode();
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

  describe('proactive relay token refresh', () => {
    // A CI relay token exported in the shell would satisfy the non-forced
    // getRelayAccessToken() read cache-only and skip the session refresh
    // these cases exercise; the outer beforeEach pins it unset for every
    // test in this file unless a case opts in.
    it.each([
      'api-key',
      'openrouter',
      'chatgpt-subscription',
      undefined,
    ] as const)(
      'never rebuilds a client on route %s for an expiring session token',
      async (route) => {
        const streamId =
          `retry-state-proactive-${route ?? 'unknown'}` as StreamTabId;
        const refreshClient = vi.fn(async () => undefined);
        const { node } = createRetryNode(streamId, refreshClient, route);
        SupabaseClient.setTokenExpiry(Date.now() + 60_000);

        const operation = vi.fn(async () => 'response');
        await expect(node.runWithAbort(operation)).resolves.toBe('response');

        expect(operation).toHaveBeenCalledOnce();
        expect(refreshClient).not.toHaveBeenCalled();
      },
    );

    it('rebuilds the relay client once when the session token rotates', async () => {
      const streamId = 'retry-state-proactive-relay-rotation' as StreamTabId;
      const refreshClient = vi.fn(async () => undefined);
      const { node } = createRetryNode(streamId, refreshClient, 'relay');
      SupabaseClient.setTokenExpiry(Date.now() + 60_000);
      const ensureFreshToken = vi.fn(async () => {
        // Simulate rotation: the refresh pushes the session expiry out.
        SupabaseClient.setTokenExpiry(Date.now() + 3_600_000);
        return 'fresh-session-token';
      });
      SupabaseClient.setAuthProvider(
        createAuthTokenProvider({ ensureFreshToken }),
      );

      const operation = vi.fn(async () => 'response');
      await expect(node.runWithAbort(operation)).resolves.toBe('response');

      expect(ensureFreshToken).toHaveBeenCalledOnce();
      expect(refreshClient).toHaveBeenCalledOnce();
      expect(operation).toHaveBeenCalledOnce();
    });

    it('skips the relay client rebuild when the token did not rotate', async () => {
      const streamId = 'retry-state-proactive-relay-stale' as StreamTabId;
      const refreshClient = vi.fn(async () => undefined);
      const { node } = createRetryNode(streamId, refreshClient, 'relay');
      SupabaseClient.setTokenExpiry(Date.now() + 60_000);
      // The provider answers with the stale token and leaves the expiry
      // clock inside the threshold, so no rotation is observed.
      const ensureFreshToken = vi.fn(async () => 'stale-session-token');
      SupabaseClient.setAuthProvider(
        createAuthTokenProvider({ ensureFreshToken }),
      );

      const operation = vi.fn(async () => 'response');
      await expect(node.runWithAbort(operation)).resolves.toBe('response');

      // No rebuild without rotation — the reactive 401 path remains the net.
      expect(ensureFreshToken).toHaveBeenCalledOnce();
      expect(refreshClient).not.toHaveBeenCalled();
      expect(operation).toHaveBeenCalledOnce();
    });

    it('skips the relay client rebuild when the session refresh returns null', async () => {
      const streamId =
        'retry-state-proactive-relay-null-refresh' as StreamTabId;
      const refreshClient = vi.fn(async () => undefined);
      const { node } = createRetryNode(streamId, refreshClient, 'relay');
      SupabaseClient.setTokenExpiry(Date.now() + 60_000);
      // Refresh failed or no session: ensureFreshToken resolves null and the
      // expiry clock stays inside the threshold, so no rotation is observed.
      const ensureFreshToken = vi.fn(async () => null);
      SupabaseClient.setAuthProvider(
        createAuthTokenProvider({ ensureFreshToken }),
      );

      const operation = vi.fn(async () => 'response');
      await expect(node.runWithAbort(operation)).resolves.toBe('response');

      // No rebuild when no fresh token materialized — the reactive 401 path
      // remains the net.
      expect(ensureFreshToken).toHaveBeenCalledOnce();
      expect(refreshClient).not.toHaveBeenCalled();
      expect(operation).toHaveBeenCalledOnce();
    });

    it('does no auth work for a relay client whose token is fresh', async () => {
      const streamId = 'retry-state-proactive-relay-fresh' as StreamTabId;
      const refreshClient = vi.fn(async () => undefined);
      const { node } = createRetryNode(streamId, refreshClient, 'relay');
      SupabaseClient.setTokenExpiry(Date.now() + 3_600_000);
      const ensureFreshToken = vi.fn(async () => 'session-token');
      SupabaseClient.setAuthProvider(
        createAuthTokenProvider({ ensureFreshToken }),
      );

      const operation = vi.fn(async () => 'response');
      await expect(node.runWithAbort(operation)).resolves.toBe('response');

      expect(ensureFreshToken).not.toHaveBeenCalled();
      expect(refreshClient).not.toHaveBeenCalled();
      expect(operation).toHaveBeenCalledOnce();
    });

    it('makes no auth or rebuild calls for a CI-token relay client', async () => {
      const streamId = 'retry-state-proactive-relay-ci-token' as StreamTabId;
      const refreshClient = vi.fn(async () => undefined);
      const { node } = createRetryNode(streamId, refreshClient, 'relay');
      vi.stubEnv(RELAY_TOKEN_ENV_VAR, `${RELAY_CI_TOKEN_PREFIX}fakeci123`);
      SupabaseClient.setTokenExpiry(Date.now() + 60_000);
      const ensureFreshToken = vi.fn(async () => 'session-token');
      SupabaseClient.setAuthProvider(
        createAuthTokenProvider({ ensureFreshToken }),
      );

      const operation = vi.fn(async () => 'response');
      await expect(node.runWithAbort(operation)).resolves.toBe('response');

      // The configured CI token satisfies the non-forced read cache-only: the
      // session is never consulted and the expiry clock stays stale, so the
      // rebuild is skipped too.
      expect(ensureFreshToken).not.toHaveBeenCalled();
      expect(refreshClient).not.toHaveBeenCalled();
      expect(operation).toHaveBeenCalledOnce();
    });
  });
});
