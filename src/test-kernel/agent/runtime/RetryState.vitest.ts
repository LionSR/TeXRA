// Test composition imports
import '@test/support/defaultSessionTestSetup';

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
import { noopTrace, TraceEmitter, type AgentTrace } from '@agent/trace';
import type { BaseCycleFields } from '@agent/core/flows/CommonCycleTypes';
import { ModelInvocationNode } from '@agent/core/flows/ModelInvocationNode';
import {
  RetryableInvocationNode,
  handleInvocationResult,
} from '@agent/core/flows/RetryState';
import { tagOpenAISdkError } from '@agent/modelHandlers/openai/openAISdkError';
import {
  SessionHostInteractions,
  type HostRetryInteractionOptions,
  type HostRetryRequest,
  type RetryResult,
} from '@agent/runtime/HostInteractions';
import type { ModelCell } from '@agent/runtime/ModelCell';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope, type RunScope } from '@agent/runtime/RunScope';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import type {
  ModelCredentialRoute,
  ModelCredentialSelection,
} from '@agent/types/ModelHandlerContracts';
import {
  RELAY_CI_TOKEN_PREFIX,
  RELAY_TOKEN_ENV_VAR,
  resetRelayTokenTierCacheForTests,
} from '@auth/relayToken';
import { SupabaseClient } from '@auth/SupabaseClient';
import type { AuthTokenProvider } from '@auth/TokenProvider';
import {
  attachContextWindowError,
  attachManualRetryOnlyError,
  attachSdkErrorMetadata,
} from '@common/errors/sdkError/errorMetadata';
import { installTexraModelAccess } from '@controllers/modelAccess/installTexraModelAccess';
import { setIncludedModelAccess } from '@model/includedModelAccess';
import {
  MESSAGE_TYPES,
  STREAM_PHASE,
  STREAM_STATUS,
  DEFAULT_CORE_SETTINGS,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
} from '@shared/schemas';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/support/streamStatusTestUtils';
import { createTestSession } from '@test/support/sessionTestUtils';
import { attachTranscriptRecorder } from '@transcript/TexraTranscriptRecorder';
import { StreamLogStore } from '@transcript/StreamLogStore';
import { isObject } from '@utils/core';

// Local file imports
import {
  createRecordingHost,
  sessionWithInteractions,
  testRunScope,
} from '../progressTestUtils';
import { testModelCell } from '../modelCellTestUtils';

/** Mirrors the RETRY_BACKOFF_MS implementation constant in RetryState.ts. */
const RETRY_BACKOFF_SECONDS = 1;

/** The rebind seam the retry node drives, stubbed per scenario. */
type TestRebind = (
  selection?: ModelCredentialSelection,
  signal?: AbortSignal,
) => Promise<void>;

interface TestRetryServices {
  config: { model: string };
  runScope: RunScope;
  streamId: StreamTabId;
  interactions: SessionHostInteractions;
  logger: AgentTrace;
  modelCell: Pick<ModelCell, 'getClient' | 'rebind' | 'route'>;
}

/** The client seam a retry node reads; scenarios stub the parts they drive. */
function testRetryModelCell(
  rebind: TestRebind = async () => undefined,
  route?: ModelCredentialRoute,
): TestRetryServices['modelCell'] {
  return { getClient: async () => ({}), rebind, route };
}

/** Every retry-node scenario's services; cases override what they drive. */
function retryServices(
  streamId: StreamTabId,
  {
    session,
    signal,
    ...overrides
  }: Partial<TestRetryServices> & {
    session?: SessionHandle;
    signal?: AbortSignal;
  } = {},
): TestRetryServices {
  return {
    config: { model: 'openai:test' },
    runScope: testRunScope(streamId, { session, signal }),
    streamId,
    interactions: new SessionHostInteractions(),
    logger: noopTrace,
    modelCell: testRetryModelCell(),
    ...overrides,
  };
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

  runWithRelayRecovery<T>(op: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.invokeWithRelayRecovery(op);
  }

  fallbackFor(error: Error): unknown {
    return this.getFallbackResult(error);
  }

  seedPersistent401Guards(): void {
    this._persistent401Error = new Error('persistent relay 401');
    this._hasAttemptedTokenRefresh = true;
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
  rebind: TestRebind = async () => undefined,
  route?: ModelCredentialRoute,
  // The node reads its session from `services.runScope`, so a test driving a
  // real session's host interactions must hand that same session in here.
  sessionOverride?: SessionHandle,
): RetryNodeKit {
  const requestRetry = vi.fn<RetryNodeKit['requestRetry']>();
  const session =
    sessionOverride ??
    sessionWithInteractions(
      { requestRetry, cancel: () => {} },
      new StreamStatusMachine(new SessionEventHub()),
    );
  const streamStatus = session.status;
  const node = new ExposedRetryNode().setServices(
    retryServices(streamId, {
      config: { model: 'sonnet46' },
      session,
      modelCell: testRetryModelCell(rebind, route),
    }),
  );
  return { node, session, streamStatus, requestRetry };
}

async function withRetryRunContext<T>(
  streamId: StreamTabId,
  session: SessionHandle,
  fn: () => T | Promise<T>,
): Promise<T> {
  const context = createRunContext({
    runScope: createRunScope({
      streamId,
      executionId: `${streamId}-execution` as ExecutionId,
      agentName: 'retry-test',
      session,
      signal: new AbortController().signal,
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
    modelCell: testModelCell({
      isBackgroundModeActive: () => false,
    }),
    logger: noopTrace,
  } as never);
}

interface CapturedModelRetry {
  readonly wireRoute: string;
  readonly modelRetryRoute: string;
  readonly relayRetryRoute?: string;
  readonly classifyFailure: (
    error: Error,
  ) => { retryAfterMs?: number } | undefined;
  readonly classifyModelFailure: (
    error: Error,
  ) => { retryAfterMs?: number } | undefined;
  readonly classifyRelayFailure?: (
    error: Error,
  ) => { retryAfterMs?: number } | undefined;
  readonly isWireUnobservedFailure?: (error: Error) => boolean;
  readonly isModelUnobservedFailure?: (error: Error) => boolean;
  readonly isRelayReachableFailure?: (error: Error) => boolean;
  readonly isRelayUnobservedFailure?: (error: Error) => boolean;
  readonly gateCalls: number;
}

async function captureModelRetry(
  endpoint = 'https://api.example/v1',
  credentialRoute: ModelCredentialRoute = 'api-key',
  model = 'openai:test',
  clientCredentialIdentity = 'credential-a',
): Promise<CapturedModelRetry> {
  const streamId = 'model-retry-policy' as StreamTabId;
  const session = createTestSession();
  const run = vi.spyOn(session.modelRetries, 'run');
  const client = {};
  const node = new ModelInvocationNode<BaseCycleFields>({
    operationName: 'Model call',
    streaming: false,
    storeResponse: vi.fn(),
  }).setServices({
    modelCell: testModelCell({
      config: { provider: 'openai', fullName: model },
      createResponse: async () => ({ response: 'ok' }),
      // Mirrors ModelHandler.getWireRouteKey; the node treats it as opaque.
      getWireRouteKey: () =>
        JSON.stringify([
          'openai',
          credentialRoute,
          endpoint,
          clientCredentialIdentity,
        ]),
      getModelRetryRouteKey: () =>
        JSON.stringify([
          'openai',
          credentialRoute,
          endpoint,
          clientCredentialIdentity,
          model,
        ]),
      isBackgroundModeActive: () => false,
      setOutputStreaming: () => {},
      getClient: async () => client,
      getCredentialRouteForClient: () => credentialRoute,
    }),
    logger: noopTrace,
    setting: { temperature: 0 },
    config: { model: 'openai:test' },
    runScope: testRunScope(streamId, { session }),
  } as never);

  try {
    await withRetryRunContext(streamId, session, () =>
      node.exec({ shouldStop: false, messages: [] }),
    );
    const [wireRoute, modelOptions] = run.mock.calls[0]!;
    const modelRoute = modelOptions.additionalRoutes?.[0];
    if (!modelRoute) {
      throw new Error('Expected model-specific retry route');
    }
    const relayRoute = modelOptions.trailingRoutes?.[0];
    return {
      wireRoute,
      modelRetryRoute: modelRoute.key,
      relayRetryRoute: relayRoute?.key,
      classifyFailure: modelOptions.classifyFailure,
      classifyModelFailure: modelRoute.classifyFailure,
      classifyRelayFailure: relayRoute?.classifyFailure,
      isWireUnobservedFailure: modelOptions.isUnobservedFailure,
      isModelUnobservedFailure: modelRoute.isUnobservedFailure,
      isRelayReachableFailure: relayRoute?.isReachableFailure,
      isRelayUnobservedFailure: relayRoute?.isUnobservedFailure,
      gateCalls: run.mock.calls.length,
    };
  } finally {
    session.dispose();
  }
}

function createAuthTokenProvider(
  overrides: Partial<AuthTokenProvider> = {},
): AuthTokenProvider {
  return {
    whenReady: async () => {},
    ensureFreshToken: async () => 'access-token',
    getSessionTokens: async () => null,
    getStoredSessionState: async () => 'none',
    getStoredAccountLabel: async () => null,
    isTokenExpiringSoon: () => false,
    getLastRefreshFailure: () => null,
    ...overrides,
  };
}

/** An Error carrying the HTTP status/body shape the retry classifiers read. */
function httpError(
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
): Error {
  return Object.assign(new Error(message), { status, ...extra });
}

/** A status-less OpenAI server_error response, tagged as the SDK would. */
function statuslessServerError(message: string): OpenAIAPIError {
  const body = { type: 'server_error', code: 'server_error', message };
  const error = new OpenAIAPIError(undefined, body, message, undefined);
  tagOpenAISdkError(error, 'openai');
  return error;
}

/** Collects the modelRetryLifecycle domain events a TraceEmitter sees. */
function collectRetryLifecycleEvents(
  logger: TraceEmitter,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  logger.subscribe((event) => {
    if (
      event.type === 'domain' &&
      event.key === 'modelRetryLifecycle' &&
      isObject(event.data)
    ) {
      events.push(event.data);
    }
  });
  return events;
}

describe('RetryState', () => {
  beforeEach(() => {
    vi.stubEnv(RELAY_TOKEN_ENV_VAR, '');
    installTexraModelAccess();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetRelayTokenTierCacheForTests();
    setIncludedModelAccess(null);
    SupabaseClient.resetForTests();
    await installPlatform();
  });

  it('records a failed invocation without logging bookkeeping', () => {
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
      },
      state,
      { logger: noopTrace, operationName: 'Model request' },
    );

    expect(result).toBeNull();
    expect(state.lastError).toEqual({
      message: 'HTTP 503 Service Unavailable',
      userRetryable: true,
    });
  });

  it('logs an empty model response at the invocation boundary', () => {
    const state: BaseCycleFields = {
      messages: [],
      shouldStop: false,
      endTurn: true,
    };
    const error = vi.fn();
    const logger = { ...noopTrace, error } as AgentTrace;

    const result = handleInvocationResult(
      { kind: 'success', response: undefined },
      state,
      { logger, operationName: 'Model request' },
    );

    expect(result).toBeNull();
    expect(state.lastError?.message).toContain('Model response was empty');
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      'Model request failed',
      expect.objectContaining({
        data: expect.objectContaining({
          message: expect.stringContaining('Model response was empty'),
        }),
      }),
    );
  });

  // Node.maxRetries counts the initial attempt plus auto-retries, so the
  // resolved value is 1 + the configured (or default) attempt count.
  it.each([
    {
      name: 'settings are unset',
      stored: undefined,
      expectedAttempts: DEFAULT_CORE_SETTINGS.model.retry.maxAttempts,
    },
    {
      name: 'the stored count is the canonical maximum',
      stored: MODEL_RETRY_MAX_ATTEMPTS_SETTING.max,
      expectedAttempts: MODEL_RETRY_MAX_ATTEMPTS_SETTING.max,
    },
    {
      name: 'the stored count exceeds the canonical maximum',
      stored: MODEL_RETRY_MAX_ATTEMPTS_SETTING.max + 1,
      expectedAttempts: DEFAULT_CORE_SETTINGS.model.retry.maxAttempts,
    },
  ])(
    'resolves the canonical retry count and delay when $name',
    async ({ stored, expectedAttempts }) => {
      if (stored !== undefined) {
        await installPlatform({
          config: { 'texra.model.retry.maxAttempts': stored },
        });
      }

      const node = new ExposedRetryNode();

      expect(node.maxRetries).toBe(1 + expectedAttempts);
      expect(node.wait).toBe(RETRY_BACKOFF_SECONDS);
    },
  );

  it('records cumulative attempt and manual-decision diagnostics', async () => {
    await installPlatform({
      config: { 'texra.model.retry.maxAttempts': 0 },
    });
    const streamId = 'retry-diagnostics' as StreamTabId;
    const logger = new TraceEmitter();
    const transcript = StreamLogStore.ephemeral('retry diagnostics test');
    transcript.ensureStream(streamId);
    const recorder = attachTranscriptRecorder(
      logger,
      transcript.acquireWriter(streamId, streamId),
    );
    const requestRetry = vi.fn(async () => ({ action: 'retry' as const }));
    const session = sessionWithInteractions(
      { requestRetry, cancel: () => {} },
      new StreamStatusMachine(new SessionEventHub()),
    );

    class DiagnosticRetryNode extends ExposedRetryNode {
      attempts = 0;

      override async exec(): Promise<string> {
        return this.runWithRelayRecovery(async () => {
          this.attempts += 1;
          if (this.attempts === 1) {
            throw new Error('temporary provider failure');
          }
          return 'recovered';
        });
      }
    }

    const node = new DiagnosticRetryNode().setServices(
      retryServices(streamId, {
        session,
        logger,
        modelCell: testRetryModelCell(undefined, 'api-key'),
      }),
    );

    try {
      seedStreamStatusForTest(session.status, streamId, {
        phase: STREAM_PHASE.RUNNING,
      });

      await expect(node._exec(undefined)).resolves.toBe('recovered');

      const rows = transcript.get(streamId)?.getRange(0) ?? [];
      const diagnostics = rows
        .map((row) => row.data)
        .filter(
          (data): data is Record<string, unknown> =>
            isObject(data) && data.kind === 'model_retry_lifecycle',
        );
      expect(
        diagnostics.map((data) => ({
          event: data.event,
          attemptOrdinal: data.attemptOrdinal,
          decisionSource: data.decisionSource,
        })),
      ).toEqual([
        {
          event: 'attempt_started',
          attemptOrdinal: 1,
          decisionSource: 'automatic',
        },
        {
          event: 'attempt_failed',
          attemptOrdinal: 1,
          decisionSource: 'automatic',
        },
        {
          event: 'retry_decision_requested',
          attemptOrdinal: 1,
          decisionSource: undefined,
        },
        {
          event: 'retry_decided',
          attemptOrdinal: 1,
          decisionSource: 'human',
        },
        {
          event: 'attempt_started',
          attemptOrdinal: 2,
          decisionSource: 'human',
        },
        {
          event: 'attempt_succeeded',
          attemptOrdinal: 2,
          decisionSource: 'human',
        },
      ]);
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            executionId: 'deadbeef',
            streamId,
            automaticAttemptLimit: 1,
            credentialRoute: 'api-key',
          }),
          expect.objectContaining({
            event: 'retry_decision_requested',
            afterAttemptSource: 'automatic',
          }),
        ]),
      );
      expect(
        rows
          .filter(
            (row) =>
              isObject(row.data) && row.data.kind === 'model_retry_lifecycle',
          )
          .every(
            (row) =>
              row.verbose === false &&
              row.messageType === MESSAGE_TYPES.INTERNAL,
          ),
      ).toBe(true);
      expect(new Set(diagnostics.map((data) => data.operationId)).size).toBe(1);
      expect(
        diagnostics
          .map((data) => data.elapsedMs as number)
          .every((elapsed, index, values) =>
            index === 0
              ? elapsed >= 0
              : elapsed >= (values.at(index - 1) ?? elapsed),
          ),
      ).toBe(true);
    } finally {
      recorder.unsubscribe();
      clearStreamStatusForTest(session.status, streamId);
    }
  });

  it('counts client preparation failures and preserves automatic retry provenance', async () => {
    await installPlatform({
      config: { 'texra.model.retry.maxAttempts': 0 },
    });
    const streamId = 'retry-client-preparation' as StreamTabId;
    const logger = new TraceEmitter();
    const events = collectRetryLifecycleEvents(logger);
    const getClient = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('client preparation failed'))
      .mockResolvedValue({});
    const session = sessionWithInteractions(
      {
        requestRetry: async () => ({
          action: 'retry' as const,
          decisionSource: 'automatic' as const,
        }),
        cancel: () => {},
      },
      new StreamStatusMachine(new SessionEventHub()),
    );

    class ClientPreparationRetryNode extends ExposedRetryNode {
      override async exec(): Promise<string> {
        return this.runWithRelayRecovery(async () => 'recovered');
      }
    }

    const node = new ClientPreparationRetryNode().setServices(
      retryServices(streamId, {
        session,
        logger,
        modelCell: {
          getClient,
          rebind: async () => undefined,
          route: 'api-key',
        },
      }),
    );

    try {
      seedStreamStatusForTest(session.status, streamId, {
        phase: STREAM_PHASE.RUNNING,
      });

      await expect(node._exec(undefined)).resolves.toBe('recovered');

      expect(
        events.map((event) => [event.event, event.attemptOrdinal]),
      ).toEqual([
        ['attempt_started', 1],
        ['attempt_failed', 1],
        ['retry_decision_requested', 1],
        ['retry_decided', 1],
        ['attempt_started', 2],
        ['attempt_succeeded', 2],
      ]);
      expect(
        events.find((event) => event.event === 'retry_decided'),
      ).toMatchObject({ decisionSource: 'automatic' });
      expect(
        events.find(
          (event) =>
            event.event === 'attempt_started' && event.attemptOrdinal === 2,
        ),
      ).toMatchObject({ decisionSource: 'automatic' });
      expect(getClient).toHaveBeenCalledTimes(2);
    } finally {
      clearStreamStatusForTest(session.status, streamId);
    }
  });

  it('records a resolved result rejected by the concrete boundary as failed', async () => {
    const streamId = 'retry-invalid-result' as StreamTabId;
    const logger = new TraceEmitter();
    const events = collectRetryLifecycleEvents(logger);
    const session = createTestSession();

    class InvalidResultNode extends ExposedRetryNode {
      protected override isSuccessfulInvocationResult(
        result: unknown,
      ): boolean {
        return Boolean(result);
      }

      override async exec(): Promise<string> {
        return this.runWithRelayRecovery(async () => '');
      }
    }

    const node = new InvalidResultNode().setServices(
      retryServices(streamId, {
        session,
        logger,
        modelCell: testRetryModelCell(undefined, 'api-key'),
      }),
    );

    try {
      await expect(node._exec(undefined)).resolves.toBe('');
      expect(events.map((event) => event.event)).toEqual([
        'attempt_started',
        'attempt_failed',
      ]);
      expect(events.at(-1)).toMatchObject({
        attemptOrdinal: 1,
        failureKind: 'invalid_result',
      });
    } finally {
      session.dispose();
    }
  });

  it('treats user aborts as cancellations instead of failed invocations', () => {
    const { node } = createRetryNode('retry-user-abort' as StreamTabId);
    const abort = new DOMException('Request aborted', 'AbortError');

    expect(node.shouldAutoRetry(abort)).toBe(false);
    expect(node.fallbackFor(abort)).toEqual({ kind: 'cancelled' });
  });

  it('does not claim an unprompted retryable fallback was already logged', () => {
    const { node } = createRetryNode('retry-unprompted' as StreamTabId);
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
    });
  });

  it('auto-retries a status-less OpenAI server_error response', () => {
    const node = new ExposedRetryNode();
    const error = statuslessServerError(
      'An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 988f71d8-3453-46f1-a466-529d2a967244 in your message.',
    );

    expect(node.shouldAutoRetry(error)).toBe(true);
  });

  it('does not automatically repeat a manual-retry-only failure', () => {
    const node = new ExposedRetryNode();
    const error = Object.assign(new Error('retry explicitly'), {
      provider: 'openai',
    });
    attachManualRetryOnlyError(error);

    expect(node.shouldAutoRetry(error)).toBe(false);
  });

  it('delays an unclassified retryable failure before the next attempt', async () => {
    class StatuslessServerErrorNode extends ExposedRetryNode {
      attempts = 0;

      override async exec(): Promise<string> {
        this.attempts += 1;
        if (this.attempts > 1) return 'recovered';

        throw statuslessServerError('temporary provider failure');
      }
    }

    vi.useFakeTimers();
    try {
      const node = new StatuslessServerErrorNode().setServices(
        retryServices('retry-delay' as StreamTabId),
      );
      const retry = node._exec(undefined);
      const delayMs = RETRY_BACKOFF_SECONDS * 1000;

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
        throw httpError('temporary provider failure', 503);
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
      // The run owns one controller for the whole execution; interrupting it
      // mid-backoff must abandon the pending retry instead of waking up to
      // another attempt.
      const runController = new AbortController();
      const node = new InterruptibleBackoffNode().setServices(
        retryServices('retry-interrupt' as StreamTabId, {
          signal: runController.signal,
        }),
      );
      const retry = node._exec(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(node.attempts).toBe(1);

      runController.abort(new DOMException('Run interrupted', 'AbortError'));
      await expect(retry).resolves.toEqual({ kind: 'cancelled' });
      expect(node.attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-retries an HTTP conflict after provider SDK retries are disabled', () => {
    const node = new ExposedRetryNode();

    expect(
      node.shouldAutoRetry(httpError('request lock is still held', 409)),
    ).toBe(true);
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

  it('passes the active abort signal to relay recovery client refresh', async () => {
    const streamId = 'retry-relay-refresh-abort' as StreamTabId;
    const rebind = vi.fn(
      async (_selection?: unknown, _signal?: AbortSignal) => undefined,
    );
    const { node } = createRetryNode(streamId, rebind, 'relay');
    SupabaseClient.setAuthProvider(createAuthTokenProvider());
    const unauthorized = httpError('relay token expired', 401);
    const operation = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce('recovered');

    await expect(node.runWithRelayRecovery(operation)).resolves.toBe(
      'recovered',
    );

    const refreshSignal = rebind.mock.calls[0]?.[1];
    expect(refreshSignal).toBeInstanceOf(AbortSignal);
    expect(refreshSignal?.aborted).toBe(false);
  });

  it('records the relay 401 before a successful reactive recovery', async () => {
    const streamId = 'retry-relay-refresh-diagnostics' as StreamTabId;
    const logger = new TraceEmitter();
    const events = collectRetryLifecycleEvents(logger);
    const session = createTestSession();
    const rebind = vi.fn(async () => undefined);
    SupabaseClient.setAuthProvider(createAuthTokenProvider());
    const unauthorized = httpError('relay token expired', 401);
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce('recovered');

    class ReactiveRecoveryNode extends ExposedRetryNode {
      override async exec(): Promise<string> {
        return this.runWithRelayRecovery(operation);
      }
    }

    const node = new ReactiveRecoveryNode().setServices(
      retryServices(streamId, {
        session,
        logger,
        modelCell: testRetryModelCell(rebind, 'relay'),
      }),
    );

    try {
      await expect(node._exec(undefined)).resolves.toBe('recovered');
      expect(
        events.map((event) => ({
          event: event.event,
          attemptOrdinal: event.attemptOrdinal,
          statusCode: event.statusCode,
          recoveryPending: event.recoveryPending,
          credentialRefresh: event.credentialRefresh,
        })),
      ).toEqual([
        {
          event: 'attempt_started',
          attemptOrdinal: 1,
          statusCode: undefined,
          recoveryPending: undefined,
          credentialRefresh: undefined,
        },
        {
          event: 'attempt_failed',
          attemptOrdinal: 1,
          statusCode: 401,
          recoveryPending: true,
          credentialRefresh: true,
        },
        {
          event: 'attempt_succeeded',
          attemptOrdinal: 1,
          statusCode: undefined,
          recoveryPending: undefined,
          credentialRefresh: true,
        },
      ]);
      expect(operation).toHaveBeenCalledTimes(2);
    } finally {
      session.dispose();
    }
  });

  it('keeps node-level auto-retry for transient stream failures', () => {
    const node = createModelInvocationNode();
    const streamError = new Error('stream closed after response started');

    expect(node.shouldAutoRetry(streamError)).toBe(true);
  });

  it('does not issue a model request when the run is interrupted after prep', async () => {
    const streamId = 'model-interrupt-after-prep' as StreamTabId;
    const session = createTestSession();
    const controller = new AbortController();
    const createResponse = vi.fn(async () => ({ response: 'too late' }));
    const node = new ModelInvocationNode<BaseCycleFields>({
      operationName: 'Model call',
      streaming: false,
      storeResponse: vi.fn(),
    }).setServices({
      modelCell: testModelCell({
        createResponse,
        getClient: async () => ({}),
        isBackgroundModeActive: () => false,
        setOutputStreaming: () => {},
      }),
      logger: noopTrace,
      setting: { temperature: 0 },
      config: { model: 'openai:test' },
      runScope: testRunScope(streamId, {
        session,
        signal: controller.signal,
      }),
    } as never);
    try {
      const prep = await node.prep({
        shouldStop: false,
        messages: [],
        endTurn: false,
      });

      controller.abort();
      const result = await node._exec(prep);

      expect(result).toEqual({ kind: 'cancelled' });
      expect(createResponse).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
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

  it('uses one recovery gate for a credential and endpoint', async () => {
    const first = await captureModelRetry(
      'https://first.example/v1',
      'chatgpt-subscription',
    );
    const second = await captureModelRetry(
      'https://second.example/v1',
      'chatgpt-subscription',
    );

    expect(first.wireRoute).toBe(
      JSON.stringify([
        'openai',
        'chatgpt-subscription',
        'https://first.example/v1',
        'credential-a',
      ]),
    );
    expect(first.gateCalls).toBe(1);
    expect(second.wireRoute).not.toBe(first.wireRoute);
  });

  it('coordinates unscoped rate-limit recovery on one wire route', async () => {
    const first = await captureModelRetry(
      'https://api.example/v1',
      'api-key',
      'openai:model-a',
    );
    const second = await captureModelRetry(
      'https://api.example/v1',
      'api-key',
      'openai:model-b',
    );
    const rateLimit = httpError('rate limited', 429, {
      headers: { 'retry-after': '3' },
    });

    expect(first.wireRoute).toBe(second.wireRoute);
    expect(first.modelRetryRoute).not.toBe(second.modelRetryRoute);
    expect(first.classifyFailure(rateLimit)).toEqual({
      retryAfterMs: 3_000,
    });
    expect(first.classifyModelFailure(rateLimit)).toBeUndefined();
  });

  it('coordinates explicitly model-scoped rate limits per model', async () => {
    const first = await captureModelRetry(
      'https://api.example/v1',
      'api-key',
      'openai:model-a',
    );
    const rateLimit = httpError('model rate limited', 429, {
      headers: { 'retry-after': '3' },
      error: { type: 'rate_limit_error', scope: 'model' },
    });

    expect(first.classifyFailure(rateLimit)).toBeUndefined();
    expect(first.classifyModelFailure(rateLimit)).toEqual({
      retryAfterMs: 3_000,
    });
  });

  it('coordinates credential exhaustion across models on one wire route', async () => {
    const first = await captureModelRetry(
      'https://api.example/v1',
      'api-key',
      'openai:model-a',
    );
    const exhausted = httpError('quota exhausted', 429, {
      headers: { 'retry-after': '3' },
      error: {
        message: 'You exceeded your current quota.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    });

    expect(first.classifyFailure(exhausted)).toEqual({
      retryAfterMs: 3_000,
    });
    expect(first.classifyModelFailure(exhausted)).toBeUndefined();
  });

  it('coordinates relay request limits across providers for one user', async () => {
    const first = await captureModelRetry(
      'https://api.example/v1',
      'relay',
      'openai:model-a',
    );
    const limited = httpError('relay request rate limit reached', 429, {
      error: {
        _relay: '1',
        type: 'relay_error',
        requestLimitReached: true,
        reason: 'rate',
        retryAfterSeconds: 60,
      },
    });

    const second = await captureModelRetry(
      'https://other.example/v1',
      'relay',
      'anthropic:model-b',
    );
    const modelLimited = httpError('provider model rate limit', 429, {
      error: { type: 'rate_limit_error', scope: 'model' },
    });

    expect(first.classifyFailure(limited)).toBeUndefined();
    expect(first.classifyModelFailure(limited)).toBeUndefined();
    expect(first.relayRetryRoute).toBe(second.relayRetryRoute);
    expect(first.classifyRelayFailure?.(limited)).toEqual({
      retryAfterMs: 60_000,
      releaseProbeBeforeOperation: true,
    });
    expect(first.isWireUnobservedFailure?.(limited)).toBe(true);
    expect(first.isModelUnobservedFailure?.(limited)).toBe(true);
    expect(first.isRelayReachableFailure?.(modelLimited)).toBe(true);

    const compatibleLimited = httpError(
      'compatible endpoint request limit',
      429,
      {
        error: {
          requestLimitReached: true,
          retryAfterSeconds: 60,
        },
      },
    );

    expect(first.classifyFailure(compatibleLimited)).toEqual({});
    expect(first.classifyRelayFailure?.(compatibleLimited)).toBeUndefined();
    expect(first.isRelayReachableFailure?.(compatibleLimited)).toBe(true);

    const concurrencyLimited = httpError(
      'relay concurrency limit reached',
      429,
      {
        error: {
          _relay: '1',
          type: 'relay_error',
          requestLimitReached: true,
          reason: 'concurrency',
          retryAfterSeconds: 5,
        },
      },
    );

    expect(first.classifyRelayFailure?.(concurrencyLimited)).toEqual({
      retryAfterMs: 5_000,
    });
  });

  it('keeps relay monthly limits outside every recovery route', async () => {
    const retry = await captureModelRetry(
      'https://api.example/v1',
      'relay',
      'openai:model-a',
    );
    const monthlyLimited = httpError('monthly spending limit reached', 429, {
      error: {
        _relay: '1',
        type: 'relay_error',
        limitReached: true,
      },
    });

    expect(retry.classifyFailure(monthlyLimited)).toBeUndefined();
    expect(retry.classifyModelFailure(monthlyLimited)).toBeUndefined();
    expect(retry.classifyRelayFailure?.(monthlyLimited)).toBeUndefined();
    expect(retry.isWireUnobservedFailure?.(monthlyLimited)).toBe(true);
    expect(retry.isModelUnobservedFailure?.(monthlyLimited)).toBe(true);
    expect(retry.isRelayReachableFailure?.(monthlyLimited)).toBe(false);
    expect(retry.isRelayUnobservedFailure?.(monthlyLimited)).toBe(true);
  });

  it('isolates rate-limit recovery by stable credential identity', async () => {
    const first = await captureModelRetry(
      'https://api.example/v1',
      'api-key',
      'openai:model-a',
      'credential-a',
    );
    const sameCredential = await captureModelRetry(
      'https://api.example/v1',
      'api-key',
      'openai:model-a',
      'credential-a',
    );
    const replacement = await captureModelRetry(
      'https://api.example/v1',
      'api-key',
      'openai:model-a',
      'credential-b',
    );

    expect(sameCredential.wireRoute).toBe(first.wireRoute);
    expect(replacement.wireRoute).not.toBe(first.wireRoute);
  });

  it.each([
    {
      name: 'recognizes the nested Undici stream timeout from long model calls',
      error: new Error('Connection error', {
        cause: new TypeError('fetch failed', {
          cause: Object.assign(
            new Error('HTTP/2: "stream timeout after 300000"'),
            { code: 'UND_ERR_INFO' },
          ),
        }),
      }),
      expected: { retryAfterMs: undefined },
    },
    {
      name: 'recognizes handler-tagged connection closures as route failures',
      error: (() => {
        const closure = new Error(
          'WebSocket closed unexpectedly (code: 1006, reason: idle timeout)',
        );
        attachSdkErrorMetadata(closure, {
          provider: 'openai',
          kind: 'connection',
        });
        return closure;
      })(),
      expected: { retryAfterMs: undefined },
    },
    {
      name: 'recognizes a retryable HTTP status carried by an SDK error cause',
      error: new Error('request failed', {
        cause: httpError('service unavailable', 503, {
          headers: { 'retry-after': '7' },
        }),
      }),
      expected: { retryAfterMs: 7_000 },
    },
    {
      name: 'coordinates a structured status-less server failure from the OpenAI SDK',
      error: statuslessServerError('temporary provider failure'),
      expected: { retryAfterMs: undefined },
    },
    {
      name: 'coordinates a structured status-less server failure from a background response',
      error: Object.assign(new Error('background response failed'), {
        provider: 'openai',
        error: {
          code: 'server_error',
          message: 'temporary background failure',
        },
      }),
      expected: { retryAfterMs: undefined },
    },
    {
      name: 'does not classify deterministic Undici request errors as route failures',
      error: new TypeError('fetch failed', {
        cause: Object.assign(new Error('invalid request option'), {
          code: 'UND_ERR_INVALID_ARG',
        }),
      }),
      expected: undefined,
    },
    {
      name: 'keeps per-response flow retries local to their invocation',
      error: new Error('stream ended before the final response event'),
      expected: undefined,
    },
    {
      name: 'honors retry-after guidance for shared HTTP failures',
      error: httpError('busy', 503, { headers: { 'retry-after': '12' } }),
      expected: { retryAfterMs: 12_000 },
    },
  ])('$name', async ({ error, expected }) => {
    const { classifyFailure } = await captureModelRetry();

    expect(classifyFailure(error)).toEqual(expected);
  });

  it('keeps relay 401s out of route cooling and out of auto-retry', async () => {
    // Token refresh is single-flighted at the auth boundary and repaired by
    // invokeWithRelayRecovery's reactive recovery inside the same node attempt;
    // cooling the shared route on a 401 would only serialize healthy peers.
    const { classifyFailure } = await captureModelRetry(
      'https://api.example/v1',
      'relay',
    );
    const unauthorized = httpError('relay token expired', 401);

    expect(createModelInvocationNode().shouldAutoRetry(unauthorized)).toBe(
      false,
    );
    expect(classifyFailure(unauthorized)).toBeUndefined();
  });

  it('does not gate unrelated calls after a 401 on the api-key route', async () => {
    const { classifyFailure } = await captureModelRetry(
      'https://api.example/v1',
      'api-key',
    );
    const unauthorized = httpError('credential rejected', 401);

    expect(classifyFailure(unauthorized)).toBeUndefined();
  });

  it('does not share model-specific permission failures across relay calls', async () => {
    const { classifyFailure } = await captureModelRetry(
      'https://api.example/v1',
      'relay',
    );

    expect(
      classifyFailure(httpError('model access denied', 403)),
    ).toBeUndefined();
  });

  it('retries HTTP conflicts locally without cooling the shared route', async () => {
    const { classifyFailure } = await captureModelRetry();
    const error = httpError('conflict', 409);

    expect(createModelInvocationNode().shouldAutoRetry(error)).toBe(true);
    expect(classifyFailure(error)).toBeUndefined();
  });

  it('never auto-retries a context-window overflow', () => {
    // Regression for the retry storm where a context-window overflow that
    // slipped past provider-specific compaction recovery (e.g. no
    // previous_response_id to chain from) was flattened into a plain,
    // code-free Error by the WebSocket transport before classification ran,
    // so it looked identical to a genuinely transient failure and got
    // auto-retried with the exact same oversized payload forever. The base
    // shouldAutoRetry gate must refuse a context-window error unconditionally.
    const node = createModelInvocationNode();
    const overflow = new Error('OpenAI WebSocket response failed: overflow');
    attachContextWindowError(overflow);

    expect(node.shouldAutoRetry(overflow)).toBe(false);
  });

  it('updates the run session status during manual retry', async () => {
    const streamId = 'retry-state-owner' as StreamTabId;
    const { node, session, streamStatus, requestRetry } =
      createRetryNode(streamId);

    requestRetry.mockResolvedValueOnce({ action: 'retry' });

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.RUNNING,
      });

      await withRetryRunContext(streamId, session, () =>
        node.promptFor(new Error('temporary provider failure')),
      );

      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.RUNNING);
      expect(requestRetry).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId,
          operation: 'Model request',
          model: 'sonnet46',
        }),
        // Every run carries a model cell, so the host is always offered the
        // credential-selecting retry preparation.
        expect.objectContaining({ prepareRetry: expect.any(Function) }),
      );
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('clears persistent 401 recovery state after the host prepares a replacement client', async () => {
    const streamId = 'retry-state-prepared-client' as StreamTabId;
    const rebind = vi.fn(async () => undefined);
    const { node, session, streamStatus, requestRetry } = createRetryNode(
      streamId,
      rebind,
      'relay',
    );
    requestRetry.mockImplementationOnce(async (_request, options) => {
      await options?.prepareRetry?.('configured');
      return { action: 'retry' };
    });
    node.seedPersistent401Guards();
    const ensureFreshToken = vi.fn(async () => 'replacement-token');
    SupabaseClient.setAuthProvider(
      createAuthTokenProvider({ ensureFreshToken }),
    );

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.RUNNING,
      });

      await expect(
        withRetryRunContext(streamId, session, () =>
          node.retryPrompt(undefined, new Error('temporary provider failure')),
        ),
      ).resolves.toBe(true);

      const unauthorized = httpError('new relay 401', 401);
      const operation = vi
        .fn<(signal: AbortSignal) => Promise<string>>()
        .mockRejectedValueOnce(unauthorized)
        .mockResolvedValueOnce('recovered');

      await expect(node.runWithRelayRecovery(operation)).resolves.toBe(
        'recovered',
      );
      expect(operation).toHaveBeenCalledTimes(2);
      expect(ensureFreshToken).toHaveBeenCalledOnce();
      expect(rebind).toHaveBeenCalledTimes(2);
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('resolves manual retries through the session host interactions', async () => {
    const streamId = 'retry-state-session-bridge' as StreamTabId;
    const session = createTestSession();
    const recording = createRecordingHost();
    session.useHostInteractions(recording.interactions);
    const { node } = createRetryNode(streamId, undefined, undefined, session);
    const streamStatus = session.status;

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.RUNNING,
      });

      const prompt = withRetryRunContext(streamId, session, () =>
        node.promptFor(new Error('temporary provider failure')),
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

  it('stops the stream after manual retry cancellation', async () => {
    const streamId = 'retry-state-cancel' as StreamTabId;
    const { node, session, streamStatus, requestRetry } =
      createRetryNode(streamId);

    requestRetry.mockResolvedValueOnce({ action: 'cancel' });

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.RUNNING,
      });

      await withRetryRunContext(streamId, session, () =>
        node.promptFor(new Error('temporary provider failure')),
      );

      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('classifies a policy/headless retry denial as failed, not cancelled (#7331)', async () => {
    const streamId = 'retry-state-deny' as StreamTabId;
    const { node, session, streamStatus, requestRetry } =
      createRetryNode(streamId);

    requestRetry.mockResolvedValueOnce({
      action: 'deny',
      reason: 'Denied by TeXRA approval policy.',
    });
    const error = new Error('stream dropped before first token');

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.RUNNING,
      });

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
    it('never rebuilds a client on a non-relay route for an expiring session token', async () => {
      const streamId = 'retry-state-proactive-api-key' as StreamTabId;
      const rebind = vi.fn(async () => undefined);
      const { node } = createRetryNode(streamId, rebind, 'api-key');
      SupabaseClient.setAuthProvider(
        createAuthTokenProvider({ isTokenExpiringSoon: () => true }),
      );

      const operation = vi.fn(async () => 'response');
      await expect(node.runWithRelayRecovery(operation)).resolves.toBe(
        'response',
      );

      expect(operation).toHaveBeenCalledOnce();
      expect(rebind).not.toHaveBeenCalled();
    });

    it('rebuilds the relay client once when the session token rotates', async () => {
      const streamId = 'retry-state-proactive-relay-rotation' as StreamTabId;
      const rebind = vi.fn(async () => undefined);
      const { node } = createRetryNode(streamId, rebind, 'relay');
      let expiringSoon = true;
      const ensureFreshToken = vi.fn(async () => {
        // Simulate rotation: the refresh pushes the session expiry out.
        expiringSoon = false;
        return 'fresh-session-token';
      });
      SupabaseClient.setAuthProvider(
        createAuthTokenProvider({
          ensureFreshToken,
          isTokenExpiringSoon: () => expiringSoon,
        }),
      );

      const operation = vi.fn(async () => 'response');
      await expect(node.runWithRelayRecovery(operation)).resolves.toBe(
        'response',
      );

      expect(ensureFreshToken).toHaveBeenCalledOnce();
      expect(rebind).toHaveBeenCalledOnce();
      expect(operation).toHaveBeenCalledOnce();
    });

    // No rebuild without an observed rotation — the reactive 401 path remains
    // the net. A null refresh (failed refresh or no session) likewise leaves
    // the expiry clock inside the threshold, so no rotation is observed.
    it.each([
      {
        name: 'the token did not rotate',
        refreshed: 'stale-session-token' as string | null,
      },
      { name: 'the session refresh returns null', refreshed: null },
    ])('skips the relay client rebuild when $name', async ({ refreshed }) => {
      const streamId = 'retry-state-proactive-relay-stale' as StreamTabId;
      const rebind = vi.fn(async () => undefined);
      const { node } = createRetryNode(streamId, rebind, 'relay');
      const ensureFreshToken = vi.fn(async () => refreshed);
      SupabaseClient.setAuthProvider(
        createAuthTokenProvider({
          ensureFreshToken,
          isTokenExpiringSoon: () => true,
        }),
      );

      const operation = vi.fn(async () => 'response');
      await expect(node.runWithRelayRecovery(operation)).resolves.toBe(
        'response',
      );

      expect(ensureFreshToken).toHaveBeenCalledOnce();
      expect(rebind).not.toHaveBeenCalled();
      expect(operation).toHaveBeenCalledOnce();
    });

    it('does no auth work for a relay client whose token is fresh', async () => {
      const streamId = 'retry-state-proactive-relay-fresh' as StreamTabId;
      const rebind = vi.fn(async () => undefined);
      const { node } = createRetryNode(streamId, rebind, 'relay');
      const ensureFreshToken = vi.fn(async () => 'session-token');
      SupabaseClient.setAuthProvider(
        createAuthTokenProvider({ ensureFreshToken }),
      );

      const operation = vi.fn(async () => 'response');
      await expect(node.runWithRelayRecovery(operation)).resolves.toBe(
        'response',
      );

      expect(ensureFreshToken).not.toHaveBeenCalled();
      expect(rebind).not.toHaveBeenCalled();
      expect(operation).toHaveBeenCalledOnce();
    });

    it('makes no auth or rebuild calls for a CI-token relay client', async () => {
      const streamId = 'retry-state-proactive-relay-ci-token' as StreamTabId;
      const rebind = vi.fn(async () => undefined);
      const { node } = createRetryNode(streamId, rebind, 'relay');
      vi.stubEnv(RELAY_TOKEN_ENV_VAR, `${RELAY_CI_TOKEN_PREFIX}fakeci123`);
      const ensureFreshToken = vi.fn(async () => 'session-token');
      SupabaseClient.setAuthProvider(
        createAuthTokenProvider({
          ensureFreshToken,
          isTokenExpiringSoon: () => true,
        }),
      );

      const operation = vi.fn(async () => 'response');
      await expect(node.runWithRelayRecovery(operation)).resolves.toBe(
        'response',
      );

      // The configured CI token satisfies the non-forced read cache-only: the
      // session is never consulted and the expiry clock stays stale, so the
      // rebuild is skipped too.
      expect(ensureFreshToken).not.toHaveBeenCalled();
      expect(rebind).not.toHaveBeenCalled();
      expect(operation).toHaveBeenCalledOnce();
    });
  });
});
