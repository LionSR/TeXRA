/**
 * The invoker's two owners of retry, over the run history.
 *
 * Automatic resends are route-scoped: llm's `ModelError` verdict decides
 * whether an attempt repeats at all, and `routePolicies` what the process's
 * recovery gate is told about the wire route. Past the budget a person decides, durably: a
 * `failed` row that asks, its `request.opened`, and a decision that is a
 * retry, a denial (failed, never cancelled — #7331) or a cancellation.
 */

// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schema,
  Scope,
  Stream,
  SynchronizedRef,
} from 'effect';
import { TestClock } from 'effect/testing';
import { it } from '@effect/vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import {
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
import { appendRow, positionRow } from '@agent/runtime/loop/rows';
import {
  ModelInvoker,
  modelInvokerLayer,
  type InvokeRequest,
} from '@agent/runtime/ModelInvoker';
import { ModelRetryGate } from '@agent/runtime/ModelRetryGate';
import { RouteRetries } from '@agent/runtime/run/invocation';
import { AgentRun, type AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
import { routePolicies } from '@agent/runtime/modelAccess/failureInfo';
import { modelAccessLayer } from '@agent/runtime/modelAccess/ModelAccess';
import {
  AgentConfigSchema,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  RUN_PHASE,
  type RunId,
} from '@shared/schemas';
import {
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import {
  RunHistory,
  RunHistoryRefused,
  type RunCell,
} from '@shared/session/runHistory';
import { UsageLog } from '@shared/usageLog';
import { freshRunState, type RunState } from '@shared/session/runState';
import { Settings } from '@shared/config/settings';
import {
  setTestApprovalPolicy,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { testAgentRun } from '@test/support/scriptedRunLayers';
import { closeSessionOf } from '@test/support/sessionEnd';
import { noopTrace } from '@test/support/noopTrace';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { hostStores, installPlatform } from '@test/support/setupPlatform';
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

const PREPARED: ResolvedTurn = Schema.decodeUnknownSync(ResolvedTurnSchema)({
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
  Schema.decodeUnknownSync(ResolvedTurnSchema)({
    ...PREPARED,
    mode: 'background',
  }) as Extract<ResolvedTurn, { mode: 'background' }>;

const PROVIDER_RESPONSE_ID = 'resp-1';

/** A completed turn with one assistant message and no tool calls. */
function completedTurn(text: string): TurnResult {
  return Schema.decodeUnknownSync(TurnResultSchema)({
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
    backend: 'openai',
    model,
    origin: ORIGIN,
    route: { kind: 'api-key', provider: 'openai', usageRoute: 'api-key' },
    forcedToolChoice: true,
    persistentConnection: false,
    billing: {},
    routes: routePolicies(['openai', 'api-key', ORIGIN.requestedModel], GPT54),
    delivery: Effect.succeed('foreground'),
    automaticRetries: MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue,
    textOnly: false,
    ...overrides,
  };
}

const REQUEST: InvokeRequest = {
  system: undefined,
  tools: [],
  toolChoice: 'auto',
};

let retryRunCounter = 0;

/** Run ids are hex, so each scenario takes the next id in sequence. */
function retryRunId(): RunId {
  return `ac${(retryRunCounter++).toString(16).padStart(4, '0')}` as RunId;
}

const CONFIG = Schema.decodeUnknownSync(AgentConfigSchema)({
  agent: 'assistant',
  model: GPT54,
});

/**
 * The run service the invoker reads: identity, session, trace, binding. A
 * rebind keeps the stub (a fresh copy of the binding).
 */
function agentRun(
  runId: RunId,
  session: SessionHandle,
  model: SynchronizedRef.SynchronizedRef<BoundModel>,
): AgentRunShape {
  return testAgentRun(
    { runId, session, logger: noopTrace, model, scope: Scope.makeUnsafe() },
    {
      config: CONFIG,
      swapModel: () =>
        SynchronizedRef.updateAndGet(model, (current) => ({ ...current })),
    },
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
  /** The run's cell, holding the folded state of the freshly opened run. */
  readonly cell: RunCell;
  /** `ModelInvoker` and this run's history, with nothing left to provide. */
  readonly layer: Layer.Layer<ModelInvoker | RunHistory | RouteRetries>;
}

/**
 * Open a run aggregate the way the tool-use loop does, and build the invoker
 * that writes to it.
 */
const openRun = Effect.fn('openRun')(function* (
  session: SessionHandle,
  model: Model,
): Effect.fn.Return<
  InvokerKit,
  RunHistoryRefused | DatabaseReadFailed | DatabaseWriteFailed
> {
  const runId = retryRunId();
  publishTestRunStart(session, runId);
  yield* session.log.settled.pipe(Effect.orDie);
  const cell = yield* session.runHistory.open(runId, {
    activation: () => Effect.succeed([]),
  });
  yield* cell.append([
    appendRow(runId, [
      { role: 'user', content: [{ kind: 'text', text: 'go' }] },
    ]),
    positionRow(runId, freshState(), 'turn.ready'),
  ]);
  // The retries the binding carries, read from the session as `bindModel`
  // reads them.
  const automaticRetries = yield* Settings.get<number>(
    session.roots,
    MODEL_RETRY_MAX_ATTEMPTS_SETTING.configKey,
  ).pipe(Effect.orDie);
  const bound = yield* SynchronizedRef.make(
    boundModel(model, { automaticRetries }),
  );
  const layer = modelInvokerLayer().pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentRun, agentRun(runId, session, bound)),
        UsageLog.disabled,
        modelAccessLayer(hostStores()).pipe(Layer.provide(testHttpClientLayer)),
      ),
    ),
    Layer.merge(Layer.succeed(RunHistory, session.runHistory)),
    // The process's route gate, as `processLayer` serves it.
    Layer.provideMerge(Layer.effect(RouteRetries, ModelRetryGate.make)),
  );
  return { runId, cell, layer };
});

/** One invocation on an opened run. */
const invokeOn = ({ layer, cell }: InvokerKit) =>
  Effect.gen(function* () {
    const invoker = yield* ModelInvoker;
    return yield* invoker.invoke(cell, REQUEST);
  }).pipe(
    // `invoke`'s debug-object sink writes through the process `FileSystem`;
    // this suite runs on `it.effect`'s own runtime, so the service comes from
    // the Node layer rather than the installed platform.
    Effect.provide(layer),
    Effect.provide(nodePlatformLayer),
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

describe('ModelInvoker retry', () => {
  // The project's policy is the fake host's setting, shared by the file.
  beforeEach(() => setTestApprovalPolicy('ask'));
  afterEach(async () => {
    await installPlatform();
  });

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

  // The setting bounds the automatic batch; the human gate opens only once it
  // is spent.
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
        reason: 'Denied by the approval policy.',
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
      expect(session.view.run(runId)?.status).toBe(RUN_PHASE.RUNNING);
      requests.detach();
      yield* Fiber.interrupt(pump);
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

        // The resume opens the run again from its stored rows.
        const cell = yield* session.runHistory.open(kit.runId);
        const resumed = yield* invokeOn({ ...kit, cell });

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
      setTestApprovalPolicy('yolo');
      const stub = stubModel([
        { fail: new Error('stream dropped before first token') },
      ]);

      const kit = yield* openRun(session, stub.model);
      const { runId } = kit;
      yield* Effect.promise(() => seedActiveRun(session, runId));
      const outcome = yield* invokeOn(kit);

      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.state.lastError?.message).toContain(
          'stream dropped before first token',
        );
        expect(outcome.state.invocation?.current.failed?.next.kind).toBe('ask');
      }
      // A denial is not a cancel: the run stays running so the failure can
      // terminalize (#7331).
      expect(session.view.run(runId)?.status).toBe(RUN_PHASE.RUNNING);
      expect(stub.attempts()).toBe(1);
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
        const anchored = Schema.decodeUnknownSync(TurnResultSchema)({
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
              Schema.decodeUnknownSync(ResolvedTurnSchema)({
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
        yield* kit.cell.append([
          appendRow(kit.runId, [
            { role: 'user', content: [{ kind: 'text', text: 'again' }] },
          ]),
        ]);
        const outcome = yield* invokeOn(kit);

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
        const get = session.runs.get.bind(session.runs);
        vi.spyOn(session.runs, 'get').mockImplementation(((runId?: RunId) => {
          if (runId === undefined) return get();
          const live = get(runId);
          const stopReason = stopped.get(runId);
          if (stopReason === undefined) return live;
          // The run's stop, whether or not this registry holds it.
          return {
            runId,
            handle: undefined,
            live: false,
            readsMessages: false,
            parent: null,
            drained: Effect.void,
            ...live,
            stopReason,
          };
        }) as typeof session.runs.get);
        const background = BACKGROUND_PREPARED;
        const operation = Schema.decodeUnknownSync(RemoteOperationSchema)({
          origin: ORIGIN,
          providerResponseId: PROVIDER_RESPONSE_ID,
          afterSequence: 0,
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
                  return Schema.decodeUnknownSync(BackgroundSubmissionSchema)(
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
                      Schema.decodeUnknownSync(BackgroundEventSchema)({
                        kind: 'completed',
                        afterSequence: 1,
                        result: completedTurn('observed'),
                      }),
                    );
              },
              cancel: () =>
                Effect.sync(() => {
                  calls.cancel += 1;
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
          const resumed = yield* invokeOn({
            ...kit,
            cell: yield* session.runHistory.open(kit.runId),
          });
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
