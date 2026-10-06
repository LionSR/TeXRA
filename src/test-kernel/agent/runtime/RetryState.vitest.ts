/**
 * The invoker's two owners of retry, over the run history.
 *
 * Automatic resends are route-scoped: `classifyModelFailure` decides whether
 * an attempt repeats at all and what the process's recovery gate is told
 * about the wire route. Past the budget a person decides, durably: a
 * `failed` row that asks, its `request.opened`, and a decision that is a
 * retry, a denial (failed, never cancelled — #7331) or a cancellation.
 */

// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
  Stream,
  SynchronizedRef,
} from 'effect';
import { TestClock } from 'effect/testing';
import { it } from '@effect/vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { APIError as OpenAIAPIError } from 'openai';
import { afterEach, describe, expect, vi } from 'vitest';
import {
  chooseReasoning,
  type Model,
  ModelError,
  type ModelOrigin,
  RemoteOperationSchema,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
  TurnResultSchema,
} from '@texra-ai/llm';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { appendRow, positionRow } from '@agent/runtime/loop/rows';
import {
  ModelInvoker,
  modelInvokerLayer,
  type InvokeRequest,
} from '@agent/runtime/ModelInvoker';
import { makeRunCell } from '@agent/runtime/loop/runProgram';
import { AgentRun, type AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import { classifyModelFailure } from '@agent/runtime/run/modelFailure';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { TraceEmitter, type AgentTrace } from '@agent/trace';
import { attachContextWindowError } from '@common/errors/sdkError/errorMetadata';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import {
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  RUN_PHASE,
  type RunId,
} from '@shared/schemas';
import {
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { RunHistory, RunHistoryRefused } from '@shared/session/runHistory';
import { UsageLog } from '@shared/usageLog';
import { freshRunState, type RunState } from '@shared/session/runStateFold';
import { testAgentRun } from '@test/support/scriptedRunLayers';
import { closeSessionOf } from '@test/support/sessionEnd';
import { noopTrace } from '@test/support/noopTrace';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import { readSettingFrom } from '@utils/config/platformSettings';
import { judgeFailure } from '../../../../packages/llm/src/api/verdict.js';
import {
  BackgroundEventSchema,
  BackgroundSubmissionSchema,
  ResolvedTurnSchema,
} from '../../../../packages/llm/src/turn.js';

// Local file imports
import {
  autoDecideRequests,
  seedActiveRun,
  sessionWithInteractions,
} from '../progressTestUtils';

const GPT54 = 'openai/gpt-5.4-2026-03-05';

/** Mirrors RETRY_BACKOFF_MS in ModelInvoker.ts. */
const RETRY_BACKOFF_MS = 1000;

/** One macrotask: lets the fiber under test reach its park. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

/** Advance the test clock past every park the invocation makes. */
const pumpClock = Effect.forkChild(
  Effect.forever(
    settle.pipe(Effect.andThen(TestClock.adjust(RETRY_BACKOFF_MS * 10))),
  ),
);

const ORIGIN = {
  protocol: 'openai-responses',
  codecVersion: 1,
  requestedModel: 'gpt-test',
  deployment: {
    endpoint: 'https://api.example.test/v1',
    credentialScope: 'openai',
  },
} satisfies ModelOrigin;

const PREPARED: ResolvedTurn = ResolvedTurnSchema.parse({
  ...ORIGIN,
  mode: 'foreground',
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'go' }] }],
  tools: [],
  transport: { kind: 'http' },
  controls: {
    temperature: null,
    maxOutputTokens: 1024,
    store: false,
    parallelToolCalls: false,
    toolChoice: 'auto',
    reasoning: null,
    serviceTier: null,
  },
});

const BACKGROUND_PREPARED: Extract<ResolvedTurn, { mode: 'background' }> =
  ResolvedTurnSchema.parse({ ...PREPARED, mode: 'background' }) as Extract<
    ResolvedTurn,
    { mode: 'background' }
  >;

const PROVIDER_RESPONSE_ID = 'resp-1';

/** A completed turn with one assistant message and no tool calls. */
function completedTurn(text: string): TurnResult {
  return TurnResultSchema.parse({
    kind: 'http',
    providerResponseId: PROVIDER_RESPONSE_ID,
    requestedOrigin: ORIGIN,
    returnedModel: null,
    modelFingerprint: null,
    content: [{ kind: 'message', content: [{ kind: 'text', text }] }],
    finishReason: 'stop',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: null,
      reasoningTokens: null,
    },
  });
}

/** What one stubbed attempt does. */
type AttemptOutcome =
  | { readonly ok: TurnResult }
  | { readonly fail: unknown }
  /** The stream ends without a `completed` event. */
  | { readonly silent: true }
  /** The stream never ends: the process stops while it runs. */
  | { readonly hang: true };

interface StubModel {
  readonly model: Model;
  /** Attempts the stub has served, in order. */
  readonly attempts: () => number;
}

/**
 * A `Model` that serves one outcome per attempt, repeating the last one. The
 * invoker is the only caller, so this is the whole provider surface it drives.
 */
function stubModel(outcomes: readonly AttemptOutcome[]): StubModel {
  let served = 0;
  const next = (): AttemptOutcome => {
    const outcome = outcomes[Math.min(served, outcomes.length - 1)];
    served += 1;
    if (outcome === undefined) throw new Error('No outcome to serve');
    return outcome;
  };
  const model: Model = {
    prepareTurn: () => Effect.succeed(PREPARED),
    streamTurn: () =>
      Stream.unwrap(
        Effect.sync(() => {
          const outcome = next();
          if ('fail' in outcome) {
            return Stream.fail(
              outcome.fail instanceof ModelError
                ? outcome.fail
                : judged(
                    new ModelError({
                      kind: 'transport',
                      message: 'attempt failed',
                      cause: outcome.fail,
                    }),
                  ),
            );
          }
          if ('silent' in outcome) return Stream.empty;
          if ('hang' in outcome) return Stream.never;
          const events: TurnEvent[] = [
            {
              kind: 'identified',
              providerResponseId: PROVIDER_RESPONSE_ID,
              requestedOrigin: ORIGIN,
              returnedModel: null,
            },
            { kind: 'completed', result: outcome.ok },
          ];
          return Stream.fromIterable(events);
        }),
      ),
  };
  return { model, attempts: () => served };
}

function boundModel(
  model: Model,
  overrides: Partial<BoundModel> = {},
): BoundModel {
  return {
    modelId: GPT54,
    config: MODEL_CONFIGS[GPT54],
    reasoning: chooseReasoning(MODEL_CONFIGS[GPT54]),
    backend: 'openai',
    model,
    origin: ORIGIN,
    route: { kind: 'api-key', provider: 'openai', usageRoute: 'api-key' },
    usageRoute: 'api-key',
    contextWindow: MODEL_CONFIGS[GPT54].contextWindow,
    supportsVision: false,
    supportsNativePdf: false,
    supportsNativeAudio: false,
    supportsForcedToolChoice: true,
    wireRouteKey: JSON.stringify(['openai', 'api-key', ORIGIN.requestedModel]),
    modelRetryRouteKey: JSON.stringify([
      'openai',
      'api-key',
      ORIGIN.requestedModel,
      GPT54,
    ]),
    backgroundCapable: false,
    persistentConnection: false,
    automaticRetries: MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue,
    textOnly: false,
    ...overrides,
  };
}

const REQUEST: InvokeRequest = {
  system: undefined,
  tools: [],
  toolChoice: 'auto',
  round: 0,
  debugName: 'retry',
};

let retryRunCounter = 0;

/** Run ids are hex, so each scenario takes the next id in sequence. */
function retryRunId(): RunId {
  return `ac${(retryRunCounter++).toString(16).padStart(4, '0')}` as RunId;
}

const CONFIG = AgentConfigSchema.parse({
  agent: 'assistant',
  model: GPT54,
});

/** The run service the invoker reads: identity, session, trace, binding. */
function agentRun(
  runId: RunId,
  session: SessionHandle,
  logger: AgentTrace,
  model: SynchronizedRef.SynchronizedRef<BoundModel>,
): AgentRunShape {
  return testAgentRun(
    { runId, session, logger, model, scope: Scope.makeUnsafe() },
    { config: CONFIG },
  );
}

/** The opening state of a fresh tool-use run, as the loop authors it. */
const freshState = (): RunState => ({
  ...freshRunState(0),
  family: 'toolUse',
  modelId: GPT54,
  backend: 'openai',
});

interface InvokerKit {
  readonly runId: RunId;
  /** The folded state of the freshly opened run. */
  readonly state: RunState;
  /** `ModelInvoker` and this run's history, with nothing left to provide. */
  readonly layer: Layer.Layer<ModelInvoker | RunHistory>;
}

/**
 * Open a run aggregate the way the tool-use loop does, and build the invoker
 * that writes to it.
 */
const openRun = Effect.fn('openRun')(function* (
  session: SessionHandle,
  model: Model,
  overrides: Partial<BoundModel> = {},
  logger: AgentTrace = noopTrace,
): Effect.fn.Return<
  InvokerKit,
  RunHistoryRefused | DatabaseReadFailed | DatabaseWriteFailed
> {
  const runId = retryRunId();
  publishTestRunStart(session, runId);
  yield* session.settled.pipe(Effect.orDie);
  yield* session.runHistory.acquire(runId);
  const state = yield* session.runHistory.appendBatch(runId, null, [
    appendRow(runId, [
      { role: 'user', content: [{ kind: 'text', text: 'go' }] },
    ]),
    positionRow(runId, freshState(), 'turn.ready'),
  ]);
  // The retries the binding carries, read from the session as `bindModel`
  // reads them.
  const automaticRetries = yield* readSettingFrom<number>(
    session.roots,
    MODEL_RETRY_MAX_ATTEMPTS_SETTING.configKey,
  ).pipe(Effect.orDie);
  const bound = yield* SynchronizedRef.make(
    boundModel(model, { automaticRetries, ...overrides }),
  );
  const layer = modelInvokerLayer().pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentRun, agentRun(runId, session, logger, bound)),
        UsageLog.disabled,
        LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT),
        testHttpClientLayer,
      ),
    ),
    Layer.merge(Layer.succeed(RunHistory, session.runHistory)),
  );
  return { runId, state, layer };
});

/** One invocation on an opened run. */
const invokeOn = ({ layer, runId, state }: InvokerKit) =>
  Effect.gen(function* () {
    const invoker = yield* ModelInvoker;
    return yield* invoker.invoke(yield* makeRunCell(runId, state), REQUEST);
  }).pipe(
    // `invoke`'s debug-object sink writes through the process `FileSystem`;
    // this suite runs on `it.effect`'s own runtime, so the service comes from
    // the Node layer rather than the installed platform. `LanguageModel` is
    // the unavailable port: a manual-retry rebind's catalogue discovery finds
    // no editor models here.
    Effect.provide(layer),
    Effect.provide(nodePlatformLayer),
    Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
    Effect.provide(testHttpClientLayer),
  );

/** A failure as the package's binding raises it: judged against its reply. */
const judged = (error: ModelError): ModelError =>
  judgeFailure(error, 'api-key');

/**
 * What the package raises over an SDK reply: its kind, status and
 * `retry-after`, with the SDK error (and its reply body) as the cause.
 */
function httpError(
  message: string,
  status: number,
  {
    headers,
    ...body
  }: Record<string, unknown> & {
    headers?: Record<string, string>;
  } = {},
): ModelError {
  const retryAfter = headers?.['retry-after'];
  return judged(
    new ModelError({
      kind:
        status === 401 || status === 403
          ? 'authentication'
          : 'provider-rejection',
      message,
      status,
      ...(retryAfter === undefined
        ? {}
        : { retryAfterMs: Number(retryAfter) * 1000 }),
      cause: Object.assign(new Error(message), { status, ...body }),
    }),
  );
}

/** A status-less OpenAI server_error response, as the SDK raises it. */
function statuslessServerError(message: string): ModelError {
  const body = { type: 'server_error', code: 'server_error', message };
  return judged(
    new ModelError({
      kind: 'provider-rejection',
      message,
      cause: new OpenAIAPIError(undefined, body, message, undefined),
    }),
  );
}

/** The binding every classification below ran under. */
const BOUND = boundModel(stubModel([]).model);

/**
 * The two recovery projections `gatedAttempt` hands the session gate: the
 * wire route cools on shared-route evidence, the model route only on a limit
 * the provider scoped to one model.
 */
const wireRouteRecovery = (
  error: Error,
): { retryAfterMs: number | undefined } | undefined => {
  const { verdict } = classifyModelFailure(error, BOUND);
  return verdict.wireRouteFailure
    ? { retryAfterMs: verdict.retryAfterMs }
    : undefined;
};
const modelRouteRecovery = (
  error: Error,
): { retryAfterMs: number | undefined } | undefined => {
  const { verdict } = classifyModelFailure(error, BOUND);
  return verdict.rateLimitScope === 'model'
    ? { retryAfterMs: verdict.retryAfterMs }
    : undefined;
};

describe('model failure classification', () => {
  it('treats a user abort as a cancellation, never an automatic retry', () => {
    const abort = new DOMException('Request aborted', 'AbortError');

    expect(classifyModelFailure(abort, BOUND).autoRetryable).toBe(false);
  });

  it('carries the text streamed before the failure onto the retry surface', () => {
    // The one producer of `partialText`: the loop hands `classifyModelFailure`
    // the tail it had already received, and the retry panel reads it back off
    // the classified error rather than from a provider handler.
    const error = new OpenAIAPIError(
      500,
      { message: 'stream dropped' },
      'stream dropped',
      undefined,
    );

    const failure = classifyModelFailure(error, BOUND, 'partial answer');

    expect(failure.formatted.partialText).toBe('partial answer');
    expect(failure.info.partialText).toBe('partial answer');
    // A failure with nothing streamed carries no tail at all.
    expect(
      classifyModelFailure(statuslessServerError('nothing streamed'), BOUND)
        .formatted.partialText,
    ).toBeUndefined();
  });

  it('reports a retryable provider failure with its formatted message', () => {
    const error = new OpenAIAPIError(
      503,
      { message: 'transient provider failure' },
      'transient provider failure',
      undefined,
    );

    expect(classifyModelFailure(error, BOUND).formatted).toMatchObject({
      message: 'HTTP 503 Service Unavailable – 503 transient provider failure',
      userRetryable: true,
    });
  });

  it.each([
    {
      name: 'a status-less OpenAI server_error response',
      error: statuslessServerError('temporary provider failure'),
      autoRetryable: true,
    },
    {
      name: 'an unknown status-less provider reply',
      error: judged(
        new ModelError({
          kind: 'provider-rejection',
          message: 'Unexpected provider failure.',
          cause: new OpenAIAPIError(
            undefined,
            {
              type: 'unexpected_error',
              message: 'Unexpected provider failure.',
            },
            'Unexpected provider failure.',
            undefined,
          ),
        }),
      ),
      autoRetryable: false,
    },
    {
      name: 'an HTTP conflict after provider SDK retries are disabled',
      error: httpError('request lock is still held', 409),
      autoRetryable: true,
    },
    {
      name: 'a transient stream failure',
      error: new Error('stream closed after response started'),
      autoRetryable: true,
    },
    {
      name: 'a raw undici fetch failure',
      error: new TypeError('fetch failed', {
        cause: Object.assign(
          new Error('HTTP/2: "stream timeout after 300000"'),
          { code: 'UND_ERR_INFO', name: 'InformationalError' },
        ),
      }),
      autoRetryable: true,
    },
    {
      name: 'a wrapped provider fetch failure',
      error: new Error('Connection error', {
        cause: new TypeError('fetch failed'),
      }),
      autoRetryable: true,
    },
    {
      // Regression for the retry storm where a context-window overflow that
      // slipped past compaction recovery was flattened into a plain,
      // code-free Error by the transport before classification ran, so it
      // looked transient and got auto-retried with the same oversized payload
      // forever.
      name: 'a context-window overflow',
      error: (() => {
        const overflow = new Error(
          'OpenAI WebSocket response failed: overflow',
        );
        attachContextWindowError(overflow);
        return overflow;
      })(),
      autoRetryable: false,
    },
  ])('classifies $name', ({ error, autoRetryable }) => {
    expect(classifyModelFailure(error, BOUND).autoRetryable).toBe(
      autoRetryable,
    );
  });

  // The package's own refusals are deterministic: repeating them bills again
  // for the same answer.
  it.each(['invalid-request', 'unsupported', 'authentication'] as const)(
    'never auto-retries a %s refusal from the package',
    (kind) => {
      const error = new ModelError({ kind, message: 'refused' });

      expect(classifyModelFailure(error, BOUND).autoRetryable).toBe(false);
    },
  );
});

describe('recovery-route verdicts', () => {
  it('cools the wire route on an unscoped rate limit, not the model route', () => {
    const rateLimit = httpError('rate limited', 429, {
      headers: { 'retry-after': '3' },
    });

    expect(wireRouteRecovery(rateLimit)).toEqual({ retryAfterMs: 3_000 });
    expect(modelRouteRecovery(rateLimit)).toBeUndefined();
  });

  it('cools only the model route on an explicitly model-scoped limit', () => {
    const rateLimit = httpError('model rate limited', 429, {
      headers: { 'retry-after': '3' },
      error: { type: 'rate_limit_error', scope: 'model' },
    });

    expect(wireRouteRecovery(rateLimit)).toBeUndefined();
    expect(modelRouteRecovery(rateLimit)).toEqual({ retryAfterMs: 3_000 });
  });

  it('cools the wire route on credential exhaustion across models', () => {
    const exhausted = httpError('quota exhausted', 429, {
      headers: { 'retry-after': '3' },
      error: {
        message: 'You exceeded your current quota.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    });

    expect(wireRouteRecovery(exhausted)).toEqual({ retryAfterMs: 3_000 });
    expect(modelRouteRecovery(exhausted)).toBeUndefined();
  });

  it.each([
    {
      name: 'cools the wire route on a transport failure from long model calls',
      error: judged(
        new ModelError({
          kind: 'transport',
          message: 'Connection error',
          cause: new TypeError('fetch failed'),
        }),
      ),
      expected: { retryAfterMs: undefined },
    },
    {
      name: 'keeps a deterministic undici code local despite the fetch-failed wrapper',
      error: judged(
        new ModelError({
          kind: 'transport',
          message: 'Connection error',
          cause: new TypeError('fetch failed', {
            cause: Object.assign(new Error('invalid header'), {
              code: 'UND_ERR_INVALID_ARG',
            }),
          }),
        }),
      ),
      expected: undefined,
    },
    {
      name: 'coordinates a structured status-less server failure from the SDK',
      error: statuslessServerError('temporary provider failure'),
      expected: { retryAfterMs: undefined },
    },
    {
      name: 'coordinates a status-less server failure from a background response',
      error: judged(
        new ModelError({
          kind: 'transport',
          message: 'background response failed',
          cause: Object.assign(new Error('background response failed'), {
            error: {
              code: 'server_error',
              message: 'temporary background failure',
            },
          }),
        }),
      ),
      expected: { retryAfterMs: undefined },
    },
    {
      name: 'keeps per-response retries local to their invocation',
      error: new Error('stream ended before the final response event'),
      expected: undefined,
    },
    {
      name: 'honors retry-after guidance for shared HTTP failures',
      error: httpError('busy', 503, { headers: { 'retry-after': '12' } }),
      expected: { retryAfterMs: 12_000 },
    },
    {
      name: 'does not gate unrelated calls after a 401 on the api-key route',
      error: httpError('credential rejected', 401),
      expected: undefined,
    },
    {
      name: 'does not share model-specific permission failures across calls',
      error: httpError('model access denied', 403),
      expected: undefined,
    },
    {
      name: 'retries HTTP conflicts locally without cooling the shared route',
      error: httpError('conflict', 409),
      expected: undefined,
    },
  ])('$name', ({ error, expected }) => {
    expect(wireRouteRecovery(error)).toEqual(expected);
  });
});

describe('ModelInvoker retry', () => {
  afterEach(async () => {
    await installPlatform();
  });

  it.effect('keeps a delegated call on its own model and run history', () =>
    Effect.gen(function* () {
      const session = yield* sessionWithInteractions(undefined);
      const parentModel = stubModel([{ ok: completedTurn('parent') }]);
      const childModel = stubModel([{ ok: completedTurn('child') }]);
      const parent = yield* openRun(session, parentModel.model);
      const child = yield* openRun(session, childModel.model);

      const outcome = yield* Effect.gen(function* () {
        // A child starts while its parent's request service is still alive.
        yield* ModelInvoker;
        return yield* invokeOn(child);
      }).pipe(Effect.provide(parent.layer));

      expect(outcome.kind).toBe('response');
      expect(childModel.attempts()).toBe(1);
      expect(parentModel.attempts()).toBe(0);
      expect(
        (yield* session.runHistory.load(parent.runId))?.lastTurn,
      ).toBeNull();
      expect((yield* session.runHistory.load(child.runId))?.lastTurn).toEqual(
        completedTurn('child'),
      );
      yield* closeSessionOf(session);
    }),
  );

  // The invoker's backoff and the session gate's probe both sleep on the
  // Effect clock, so a forked pump walks the test clock past each park and
  // the scenario costs no wall time.
  it.effect('repeats an automatic attempt and returns the response', () =>
    Effect.gen(function* () {
      const session = yield* sessionWithInteractions(undefined);
      const pump = yield* pumpClock;
      const stub = stubModel([
        { fail: httpError('temporary provider failure', 503) },
        { ok: completedTurn('recovered') },
      ]);

      const outcome = yield* invokeOn(yield* openRun(session, stub.model));

      expect(outcome.kind).toBe('response');
      expect(stub.attempts()).toBe(2);
      yield* Fiber.interrupt(pump);
      yield* closeSessionOf(session);
    }),
  );

  it.effect('reports a stream that produced no completed turn as failed', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({ config: { 'texra.model.retry.maxAttempts': 0 } }),
      );
      const session = yield* sessionWithInteractions(undefined);
      const denied = autoDecideRequests(session, () => ({
        action: 'deny',
        reason: 'Denied by TeXRA approval policy.',
      }));
      const stub = stubModel([{ silent: true }]);

      const outcome = yield* invokeOn(yield* openRun(session, stub.model));

      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.error.message).toContain('Model response was empty');
      }
      denied.detach();
      yield* closeSessionOf(session);
    }),
  );

  it.effect('treats a user abort as a cancellation without prompting', () =>
    Effect.gen(function* () {
      const session = yield* sessionWithInteractions(undefined);
      const requests = autoDecideRequests(session, () => ({
        action: 'retry',
      }));
      const stub = stubModel([
        { fail: new DOMException('Request aborted', 'AbortError') },
      ]);

      const outcome = yield* invokeOn(yield* openRun(session, stub.model));

      expect(outcome.kind).toBe('cancelled');
      expect(requests.opened).toEqual([]);
      requests.detach();
      yield* closeSessionOf(session);
    }),
  );

  it.effect('abandons the pending retry when the run is interrupted', () =>
    Effect.gen(function* () {
      const session = yield* sessionWithInteractions(undefined);
      const backoffStarted = yield* Deferred.make<void>();
      const logger = new TraceEmitter((event) => {
        if (event.type === 'log' && event.message.includes('automatic retry')) {
          Deferred.doneUnsafe(backoffStarted, Effect.void);
        }
      });
      const stub = stubModel([
        { fail: httpError('temporary provider failure', 503) },
        { ok: completedTurn('too late') },
      ]);

      const kit = yield* openRun(session, stub.model, {}, logger);
      const fiber = yield* Effect.forkChild(invokeOn(kit));
      // The interrupt lands while the fiber is parked in the backoff, so it
      // must abandon the retry instead of waking to another billed attempt.
      yield* Deferred.await(backoffStarted);
      yield* settle;
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      // Nothing is left parked in the backoff: moving the clock past it bills
      // no further attempt.
      yield* TestClock.adjust(RETRY_BACKOFF_MS * 10);
      yield* settle;

      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(stub.attempts()).toBe(1);
      yield* closeSessionOf(session);
    }),
  );

  // The authorized attempt waits out the session gate's cooldown the failed
  // attempt opened; the pump advances the test clock past it.
  it.effect('admits a manual retry through a durable approval', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({ config: { 'texra.model.retry.maxAttempts': 0 } }),
      );
      const session = yield* sessionWithInteractions(undefined);
      const pump = yield* pumpClock;
      const requests = autoDecideRequests(session, () => ({
        action: 'retry',
      }));
      const stub = stubModel([
        { fail: httpError('temporary provider failure', 503) },
        { ok: completedTurn('recovered') },
      ]);

      const kit = yield* openRun(session, stub.model);
      const { runId } = kit;
      yield* Effect.promise(() => seedActiveRun(session, runId));
      const outcome = yield* invokeOn(kit);

      expect(outcome.kind).toBe('response');
      expect(stub.attempts()).toBe(2);
      // The request the run opened carries the retry payload every surface
      // answers from.
      expect(requests.opened).toHaveLength(1);
      expect(requests.opened[0]?.payload).toMatchObject({
        kind: 'retry',
        data: expect.objectContaining({
          runId,
          operation: 'Model request',
          model: GPT54,
        }),
      });
      // The response the answer admitted closes the invocation: a resumed
      // run cannot spend the answer a second time.
      if (outcome.kind === 'response') {
        expect(outcome.state.invocation).toBeNull();
      }
      // The response retires the failure the gate recorded in its own batch:
      // a crash before the loop's next snapshot resumes a recovered run, not
      // one that re-reads the stale error and finishes FAILED.
      expect((yield* session.runHistory.load(runId))?.lastError).toBeNull();
      // The decision neither parks nor ends the run: the phase the fold
      // reports is still running.
      expect(session.runView(runId)?.status).toBe(RUN_PHASE.RUNNING);
      requests.detach();
      yield* Fiber.interrupt(pump);
      yield* closeSessionOf(session);
    }),
  );

  // As above: the authorized attempt waits out the gate cooldown, pumped.
  it.effect(
    'declines the exhausted subscription route for the run, not in settings',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({ config: { 'texra.model.retry.maxAttempts': 0 } }),
        );
        const session = yield* sessionWithInteractions(undefined);
        const pump = yield* pumpClock;
        const requests = autoDecideRequests(session, () => ({
          action: 'retry',
          credentials: 'personal',
        }));
        const stub = stubModel([
          {
            fail: httpError('subscription quota exhausted', 429, {
              error: { type: 'usage_limit_reached' },
            }),
          },
          { ok: completedTurn('recovered') },
        ]);

        const kit = yield* openRun(session, stub.model, {
          route: { kind: 'chatgpt-subscription' },
          usageRoute: 'chatgpt-subscription',
        });
        yield* Effect.promise(() => seedActiveRun(session, kit.runId));
        const outcome = yield* invokeOn(kit);

        expect(outcome.kind).toBe('response');
        // The route the failed attempt billed is declined on this run's own
        // run history, so a resume rebinds the same way and a concurrent run keeps
        // the subscription the user still prefers.
        if (outcome.kind === 'response') {
          expect(outcome.state.declinedRoutes).toStrictEqual([
            'chatgpt-subscription',
          ]);
        }
        requests.detach();
        yield* Fiber.interrupt(pump);
        yield* closeSessionOf(session);
      }),
  );

  // Failure mode: a 404 on a request that chained nothing reads as a lost
  // chain, and the "resend once" repeats without end.
  it.effect(
    'treats a gone continuation it never sent as an ordinary failure',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({ config: { 'texra.model.retry.maxAttempts': 0 } }),
        );
        const session = yield* sessionWithInteractions(undefined);
        const denied = autoDecideRequests(session, () => ({
          action: 'deny',
          reason: 'Denied by TeXRA approval policy.',
        }));
        const stub = stubModel([
          {
            fail: new ModelError({
              kind: 'continuation-gone',
              status: 404,
              message: 'No endpoints found for this model.',
            }),
          },
        ]);

        const outcome = yield* invokeOn(yield* openRun(session, stub.model));

        expect(outcome.kind).toBe('failed');
        expect(stub.attempts()).toBe(1);
        denied.detach();
        yield* closeSessionOf(session);
      }),
  );

  // Failure modes: a resume resends a billed attempt a person admitted
  // without asking again; it refills the automatic budget the rows spent.
  it.effect(
    'asks again about an approved retry the process stopped during',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({ config: { 'texra.model.retry.maxAttempts': 0 } }),
        );
        const session = yield* sessionWithInteractions(undefined);
        const pump = yield* pumpClock;
        const requests = autoDecideRequests(session, () => ({
          action: 'retry',
        }));
        const stub = stubModel([
          { fail: httpError('temporary provider failure', 503) },
          { hang: true },
          { ok: completedTurn('recovered') },
        ]);
        const kit = yield* openRun(session, stub.model);
        yield* Effect.promise(() => seedActiveRun(session, kit.runId));
        const fiber = yield* Effect.forkChild(invokeOn(kit));
        while (stub.attempts() < 2) yield* settle;
        yield* Fiber.interrupt(fiber);

        const state = yield* session.runHistory.load(kit.runId);
        if (state === null) throw new Error('The run has no run history.');
        const resumed = yield* invokeOn({ ...kit, state });

        expect(resumed.kind).toBe('response');
        // The interrupted attempt was asked about again, then sent once.
        expect(requests.opened).toHaveLength(2);
        expect(stub.attempts()).toBe(3);
        requests.detach();
        yield* Fiber.interrupt(pump);
        yield* closeSessionOf(session);
      }),
  );

  // A denial does not retry and — crucially — is NOT a user cancel, so the
  // run resumes to RUNNING to let the failure terminalize (#7331); a
  // cancelled zero-output run would report COMPLETED. The session's policy
  // makes it, in the batch that opens the request: no surface answers.
  it.effect('classifies a policy retry denial as failed, not cancelled', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({ config: { 'texra.model.retry.maxAttempts': 0 } }),
      );
      const session = yield* sessionWithInteractions(undefined);
      session.setApprovalPolicy('yolo');
      const stub = stubModel([
        { fail: new Error('stream dropped before first token') },
      ]);

      const kit = yield* openRun(session, stub.model);
      const { runId } = kit;
      yield* Effect.promise(() => seedActiveRun(session, runId));
      const outcome = yield* invokeOn(kit);

      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.error.message).toContain(
          'stream dropped before first token',
        );
        expect(outcome.state.invocation?.current.failed?.next.kind).toBe('ask');
      }
      // A denial is not a cancel: the run stays running so the failure can
      // terminalize (#7331).
      expect(session.runView(runId)?.status).toBe(RUN_PHASE.RUNNING);
      expect(stub.attempts()).toBe(1);
      yield* closeSessionOf(session);
    }),
  );

  it.effect('cancels the run when the user declines the retry', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({ config: { 'texra.model.retry.maxAttempts': 0 } }),
      );
      const session = yield* sessionWithInteractions(undefined);
      const requests = autoDecideRequests(session, () => ({
        action: 'cancel',
        cause: 'The user declined the retry.',
      }));
      const stub = stubModel([
        { fail: httpError('temporary provider failure', 503) },
      ]);

      const kit = yield* openRun(session, stub.model);
      const { runId } = kit;
      yield* Effect.promise(() => seedActiveRun(session, runId));
      const outcome = yield* invokeOn(kit);

      expect(outcome.kind).toBe('cancelled');
      expect(stub.attempts()).toBe(1);
      requests.detach();
      yield* closeSessionOf(session);
    }),
  );

  // The setting bounds the automatic batch; the human gate opens only once it
  // is spent.
  it.effect('stops automatic attempts at the configured limit', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({
          config: {
            'texra.model.retry.maxAttempts':
              MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue,
          },
        }),
      );
      const session = yield* sessionWithInteractions(undefined);
      const pump = yield* pumpClock;
      const requests = autoDecideRequests(session, () => ({
        action: 'deny',
        reason: 'Denied by TeXRA approval policy.',
      }));
      const stub = stubModel([{ fail: httpError('busy', 503) }]);

      const kit = yield* openRun(session, stub.model);
      yield* Effect.promise(() => seedActiveRun(session, kit.runId));
      yield* invokeOn(kit);

      expect(stub.attempts()).toBe(
        1 + MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue,
      );
      expect(requests.opened).toHaveLength(1);
      requests.detach();
      yield* Fiber.interrupt(pump);
      yield* closeSessionOf(session);
    }),
  );

  it.effect(
    'retries a chained request once without its continuation when the stored response is gone',
    () =>
      Effect.gen(function* () {
        const session = yield* sessionWithInteractions(undefined);
        const pump = yield* pumpClock;
        const chained: boolean[] = [];
        // The first response is stored and anchors the next request to it.
        const anchored = TurnResultSchema.parse({
          ...completedTurn('first'),
          continuation: {
            origin: { ...ORIGIN, protocol: 'openai-responses' },
            coveredMessages: 2,
            prefixFingerprint: 'a'.repeat(64),
            anchor: {
              kind: 'stored',
              responseId: 'resp-0',
              coveredItems: 2,
            },
          },
        });
        const model: Model = {
          prepareTurn: (request) =>
            Effect.succeed(
              ResolvedTurnSchema.parse({
                ...PREPARED,
                messages: request.messages,
                ...(request.continuation === undefined
                  ? {}
                  : { continuation: request.continuation }),
              }),
            ),
          streamTurn: (turn) =>
            Stream.unwrap(
              Effect.sync(() => {
                chained.push('continuation' in turn);
                return 'continuation' in turn
                  ? Stream.fail(
                      new ModelError({
                        kind: 'continuation-gone',
                        status: 404,
                        message: 'Previous response with id resp-1 not found.',
                      }),
                    )
                  : Stream.fromIterable<TurnEvent>([
                      {
                        kind: 'identified',
                        providerResponseId: PROVIDER_RESPONSE_ID,
                        requestedOrigin: ORIGIN,
                        returnedModel: null,
                      },
                      {
                        kind: 'completed',
                        result:
                          chained.length === 1
                            ? anchored
                            : completedTurn('full'),
                      },
                    ]);
              }),
            ),
        };
        const kit = yield* openRun(session, model);
        const first = yield* invokeOn(kit);
        if (first.kind !== 'response') throw new Error('no first response');
        expect(first.state.continuation).not.toBeNull();

        // The next turn's message, sent on top of the stored response.
        const next = yield* session.runHistory.appendBatch(
          kit.runId,
          first.state,
          [
            appendRow(kit.runId, [
              { role: 'user', content: [{ kind: 'text', text: 'again' }] },
            ]),
          ],
        );
        const outcome = yield* invokeOn({ ...kit, state: next });

        expect(outcome.kind).toBe('response');
        expect(chained).toEqual([false, true, false]);
        yield* Fiber.interrupt(pump);
        yield* closeSessionOf(session);
      }),
  );
  // Failure modes: a user stop leaves the remote job billing; a cancelled
  // operation is re-observed on resume; a shutdown (or any interrupt without
  // a `user` stop reason) cancels work a resume should pick back up.
  it.effect(
    'cancels an observed background response on a user stop, never on shutdown',
    () =>
      Effect.gen(function* () {
        const session = yield* sessionWithInteractions(undefined);
        const stopped = new Map<RunId, 'user' | 'shutdown'>();
        vi.spyOn(session.runs, 'stopReason').mockImplementation((runId) =>
          stopped.get(runId),
        );
        const background = BACKGROUND_PREPARED;
        const operation = RemoteOperationSchema.parse({
          origin: ORIGIN,
          providerResponseId: PROVIDER_RESPONSE_ID,
          afterSequence: 0,
          admittedFingerprint: 'a'.repeat(64),
          store: false,
        });
        const scenario = Effect.fn('scenario')(function* (
          reason: 'user' | 'shutdown',
        ) {
          const calls = { submit: 0, observe: 0, cancel: 0 };
          const observing = yield* Deferred.make<void>();
          const model: Model = {
            prepareTurn: () => Effect.succeed(background),
            streamTurn: () => Stream.die('no foreground turn'),
            background: {
              submit: () =>
                Effect.sync(() => {
                  calls.submit += 1;
                  return BackgroundSubmissionSchema.parse(
                    calls.submit === 1
                      ? { kind: 'accepted', operation, returnedModel: null }
                      : { kind: 'completed', result: completedTurn('fresh') },
                  );
                }),
              observe: () => {
                calls.observe += 1;
                return calls.observe === 1
                  ? Stream.fromEffect(
                      Deferred.succeed(observing, undefined),
                    ).pipe(Stream.drain, Stream.concat(Stream.never))
                  : Stream.make(
                      BackgroundEventSchema.parse({
                        kind: 'completed',
                        afterSequence: 1,
                        result: completedTurn('observed'),
                      }),
                    );
              },
              cancel: (op) =>
                Effect.sync(() => {
                  calls.cancel += 1;
                  return {
                    kind: 'confirmed-cancelled',
                    providerResponseId: op.providerResponseId,
                    requestedOrigin: ORIGIN,
                    returnedModel: null,
                  };
                }),
            },
          };
          const kit = yield* openRun(session, model);
          const fiber = yield* Effect.forkChild(invokeOn(kit));
          yield* Deferred.await(observing);
          stopped.set(kit.runId, reason);
          yield* Fiber.interrupt(fiber);
          const state = yield* session.runHistory.load(kit.runId);
          if (state === null)
            throw new Error('The run has no run history state.');
          const resumed = yield* invokeOn({ ...kit, state });
          return {
            calls,
            accepted: state.invocation?.current.accepted,
            resumed,
          };
        });

        const user = yield* scenario('user');
        expect(user.calls.cancel).toBe(1);
        expect(user.accepted).toBeNull();
        // The resume submits anew instead of observing the cancelled work.
        expect(user.calls).toEqual({ submit: 2, observe: 1, cancel: 1 });
        expect(user.resumed.kind).toBe('response');

        const shutdown = yield* scenario('shutdown');
        expect(shutdown.accepted?.operation).toEqual(operation);
        // The resume observes the operation the shutdown left running.
        expect(shutdown.calls).toEqual({ submit: 1, observe: 2, cancel: 0 });
        expect(shutdown.resumed.kind).toBe('response');
        yield* closeSessionOf(session);
      }),
  );
});
