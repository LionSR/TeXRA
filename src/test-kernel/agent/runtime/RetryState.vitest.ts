/**
 * The invoker's two owners of retry, over the run history.
 *
 * Automatic resends are route-scoped: llm's `ModelError` verdict decides
 * whether an attempt repeats at all, and `routePolicies` what the process's
 * recovery gate is told about the wire route. Past the budget a person decides, durably: a
 * `failed` row that asks, its `request.opened`, and a decision that is a
 * retry, a denial (failed, never cancelled — #7331) or a cancellation.
 */

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
  Context,
} from 'effect';
import { TestClock } from 'effect/testing';
import { layer } from '@effect/vitest';

import { expect, vi } from 'vitest';
import {
  type Model,
  MODEL_CONFIGS,
  ModelError,
  type ModelOrigin,
  RemoteOperationSchema,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
  TurnResultSchema,
} from '@texra-ai/llm';

// Local imports
import { DatabaseReadFailed } from '@texra-ai/harness';
import {
  AgentConfigSchema,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  RUN_PHASE,
  type RunId,
} from '@texra-ai/harness/schemas';
import {
  DatabaseWriteFailed,
  Secrets,
  Settings,
  UsageLog,
} from '@texra-ai/harness/host';
import { AgentRun, type AgentRunShape } from '@agent/runtime/run/AgentRun';
import { RouteRetries } from '@agent/runtime/run/invocation';
import { ModelRetryGate } from '@agent/runtime/ModelRetryGate';
import type { InvokeRequest } from '@agent/runtime/run/requestContext';
import { ModelInvoker, modelInvokerLayer } from '@agent/runtime/ModelInvoker';
import { appendRow, positionRow } from '@agent/runtime/loop/rows';
import { routePolicies } from '@agent/runtime/modelAccess/failureInfo';
import { modelAccessLayer } from '@agent/runtime/modelAccess/ModelAccess';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { Runs } from '@agent/runtime/runRegistry';
import { SessionRoots } from '@platform/rootedFs';
import {
  RunHistory,
  RunHistoryRefused,
  type RunCell,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import { freshRunState, type RunState } from '@shared/session/runState';
import {
  setTestApprovalPolicy,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { testAgentRun } from '@test/support/scriptedRunLayers';
import { noopTrace } from '@test/support/noopTrace';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { fakeHostSecrets, installedHost } from '@test/support/setupPlatform';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';
import { judgeFailure } from '../../../../packages/llm/src/api/verdict.js';
import {
  BackgroundEventSchema,
  BackgroundSubmissionSchema,
  ResolvedTurnSchema,
} from '../../../../packages/llm/src/turn.js';

// Local file imports
import { autoDecideRequests, seedActiveRun } from '../progressTestUtils';
import type { BoundModel } from '@texra-ai/harness/plugins';

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
      cacheWriteTokens: null,
      reasoningTokens: null,
      toolUsePromptTokens: null,
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
    billing: 'api-key',
    maxOutputTokens: 1024,
    background: false,
    serviceTier: null,
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
  session: Context.Context<SessionServices>,
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
  readonly layer: Layer.Layer<
    ModelInvoker | RunHistory | RouteRetries | SessionServices
  >;
}

/**
 * Open a run aggregate the way the tool-use loop does, and build the invoker
 * that writes to it.
 */
const openRun = Effect.fn('openRun')(function* (
  session: Context.Context<SessionServices>,
  model: Model,
): Effect.fn.Return<
  InvokerKit,
  RunHistoryRefused | DatabaseReadFailed | DatabaseWriteFailed
> {
  const runId = retryRunId();
  publishTestRunStart(session, runId);
  yield* Context.get(session, SessionLog).settled.pipe(Effect.orDie);
  const cell = yield* Context.get(session, RunHistory).open(runId, {
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
    Context.get(session, SessionRoots),
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
        modelAccessLayer(installedHost().roots).pipe(
          Layer.provide(
            Layer.merge(testHttpClientLayer, Secrets.layer(fakeHostSecrets)),
          ),
        ),
      ),
    ),
    Layer.merge(Layer.succeed(RunHistory, Context.get(session, RunHistory))),
    // The process's route gate, as `processLayer` serves it.
    Layer.provideMerge(Layer.effect(RouteRetries, ModelRetryGate.make)),
    Layer.provideMerge(Layer.succeedContext(session)),
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
  judgeFailure(error, 'api-key', false);

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

/**
 * A case's fresh fake host, its automatic retry budget `maxAttempts` when
 * given, and a test clock of the case's own: the invocation's backoff parks
 * on it and `pumpClock` advances it.
 */
const caseHost = (maxAttempts?: number) =>
  Layer.merge(
    FakeHost.layer(
      maxAttempts === undefined
        ? {}
        : { config: { 'model.retry.maxAttempts': maxAttempts } },
    ),
    TestClock.layer(),
  );

// Live clock for the session graph and the sessions it opens, as on the
// process runtime; each case brings its own host and test clock.
layer(SessionGraph.layer, { excludeTestServices: true })(
  'ModelInvoker retry',
  (it) => {
    it.layer(caseHost(0), { buildPerTest: true })((it) => {
      // The setting bounds the automatic batch; the human gate opens only once
      // it is spent.
      it.effect('cancels the run when the user declines the retry', () =>
        Effect.gen(function* () {
          const session = yield* isolatedTestSession();
          yield* autoDecideRequests(session, () => ({
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
        }),
      );

      // The authorized attempt waits out the session gate's cooldown the failed
      // attempt opened; the pump advances the test clock past it.
      it.effect('admits a manual retry through a durable approval', () =>
        Effect.gen(function* () {
          const session = yield* isolatedTestSession();
          const pump = yield* pumpClock;
          const requests = yield* autoDecideRequests(session, () => ({
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
          // The response retires the failure the gate recorded in its own
          // batch: a crash before the loop's next snapshot resumes a recovered
          // run, not one that re-reads the stale error and finishes FAILED.
          expect(
            (yield* Context.get(session, RunHistory).load(runId))?.lastError,
          ).toBeNull();
          // The decision neither parks nor ends the run: the phase the fold
          // reports is still running.
          expect(
            Context.get(session, SessionViewAccess).run(runId)?.status,
          ).toBe(RUN_PHASE.RUNNING);
          yield* Fiber.interrupt(pump);
        }),
      );

      // Failure modes: a resume resends a billed attempt a person admitted
      // without asking again; it refills the automatic budget the rows spent.
      it.effect(
        'asks again about an approved retry the process stopped during',
        () =>
          Effect.gen(function* () {
            const session = yield* isolatedTestSession();
            const pump = yield* pumpClock;
            const requests = yield* autoDecideRequests(session, () => ({
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
            const cell = yield* Context.get(session, RunHistory).open(
              kit.runId,
            );
            const resumed = yield* invokeOn({ ...kit, cell });

            expect(resumed.kind).toBe('response');
            // The interrupted attempt was asked about again, then sent once.
            expect(requests.opened).toHaveLength(2);
            expect(stub.attempts()).toBe(3);
            yield* Fiber.interrupt(pump);
          }),
      );

      // A denial does not retry and — crucially — is NOT a user cancel, so
      // the run resumes to RUNNING to let the failure terminalize (#7331); a
      // cancelled zero-output run would report COMPLETED. The session's
      // policy makes it, in the batch that opens the request: no surface
      // answers.
      it.effect(
        'classifies a policy retry denial as failed, not cancelled',
        () =>
          Effect.gen(function* () {
            const session = yield* isolatedTestSession();
            setTestApprovalPolicy('yolo');
            const stub = stubModel([
              { fail: new Error('stream dropped before first token') },
            ]);

            const kit = yield* openRun(session, stub.model);
            const { runId } = kit;
            yield* Effect.promise(() => seedActiveRun(session, runId));
            const outcome = yield* invokeOn(kit);

            expect(outcome.kind).toBe('failed');
            // The failure opened a retry request, so the policy's denial is
            // what ended the invocation, not a stop that never asked.
            if (outcome.kind === 'failed') {
              expect(outcome.state.invocation?.current.failed?.next.kind).toBe(
                'ask',
              );
            }
            // A denial is not a cancel: the run stays running so the failure
            // can terminalize (#7331).
            expect(
              Context.get(session, SessionViewAccess).run(runId)?.status,
            ).toBe(RUN_PHASE.RUNNING);
            expect(stub.attempts()).toBe(1);
          }),
      );
    });
    it.layer(caseHost(MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue), {
      buildPerTest: true,
    })((it) => {
      it.effect('stops automatic attempts at the configured limit', () =>
        Effect.gen(function* () {
          const session = yield* isolatedTestSession();
          const pump = yield* pumpClock;
          const requests = yield* autoDecideRequests(session, () => ({
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
          yield* Fiber.interrupt(pump);
        }),
      );
    });
    it.layer(caseHost(1), { buildPerTest: true })((it) => {
      // Failure mode: a response that kills the process while it is handled is
      // sent again on every open, without bound, because the attempt it cut
      // records no outcome.
      it.effect(
        'spends a retry on each attempt the process stopped during',
        () =>
          Effect.gen(function* () {
            const session = yield* isolatedTestSession();
            const requests = yield* autoDecideRequests(session, () => ({
              action: 'deny',
              reason: 'Denied by the approval policy.',
            }));
            const stub = stubModel([
              { hang: true },
              { hang: true },
              { ok: completedTurn('sent again') },
            ]);
            const kit = yield* openRun(session, stub.model);
            yield* Effect.promise(() => seedActiveRun(session, kit.runId));
            // Each open sends one attempt, and the process stops while it runs.
            let cell = kit.cell;
            for (const sent of [1, 2]) {
              const fiber = yield* Effect.forkChild(invokeOn({ ...kit, cell }));
              while (stub.attempts() < sent) yield* settle;
              yield* Fiber.interrupt(fiber);
              cell = yield* Context.get(session, RunHistory).open(kit.runId);
            }
            const resumed = yield* invokeOn({ ...kit, cell });

            // The second open resent within the budget; the third asks before
            // sending, and the denial ends the invocation with its failure.
            expect(resumed.kind).toBe('failed');
            expect(resumed.state.lastError).not.toBeNull();
            expect(stub.attempts()).toBe(2);
            expect(requests.opened).toHaveLength(1);
          }),
      );
    });
    it.layer(caseHost(), { buildPerTest: true })((it) => {
      it.effect(
        'retries a chained request once without its continuation when the stored response is gone',
        () =>
          Effect.gen(function* () {
            const session = yield* isolatedTestSession();
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
                            message:
                              'Previous response with id resp-1 not found.',
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
          }),
      );

      // Failure modes: a user stop leaves the remote job billing; a
      // cancelled operation is re-observed on resume; a shutdown (or any
      // interrupt without a `user` stop reason) cancels work a resume should
      // pick back up.
      it.effect(
        'cancels an observed background response on a user stop, never on shutdown',
        () =>
          Effect.gen(function* () {
            const session = yield* isolatedTestSession();
            const stopped = new Map<RunId, 'user' | 'shutdown'>();
            const runs = Context.get(session, Runs);
            const stopCause = runs.stopCause;
            // The run's stop, whether or not this registry holds it.
            vi.spyOn(runs, 'stopCause').mockImplementation(
              (runId) => stopped.get(runId) ?? stopCause(runId),
            );
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
                prepareTurn: () => Effect.succeed(BACKGROUND_PREPARED),
                streamTurn: () => Stream.die('no foreground turn'),
                background: {
                  submit: () =>
                    Effect.sync(() => {
                      calls.submit += 1;
                      return Schema.decodeUnknownSync(
                        BackgroundSubmissionSchema,
                      )(
                        calls.submit === 1
                          ? { kind: 'accepted', operation, returnedModel: null }
                          : {
                              kind: 'completed',
                              result: completedTurn('fresh'),
                            },
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
              const state = yield* Context.get(session, RunHistory).load(
                kit.runId,
              );
              if (state === null)
                throw new Error('The run has no run history state.');
              const resumed = yield* invokeOn({
                ...kit,
                cell: yield* Context.get(session, RunHistory).open(kit.runId),
              });
              return {
                calls,
                accepted: state.invocation?.current.accepted,
                resumed,
              };
            });

            const user = yield* scenario('user');
            expect(user.accepted).toBeNull();
            // The resume submits anew instead of observing the cancelled work.
            expect(user.calls).toEqual({ submit: 2, observe: 1, cancel: 1 });
            expect(user.resumed.kind).toBe('response');

            const shutdown = yield* scenario('shutdown');
            expect(shutdown.accepted?.operation).toEqual(operation);
            // The resume observes the operation the shutdown left running.
            expect(shutdown.calls).toEqual({
              submit: 1,
              observe: 2,
              cancel: 0,
            });
            expect(shutdown.resumed.kind).toBe('response');
          }),
      );
    });
  },
);
