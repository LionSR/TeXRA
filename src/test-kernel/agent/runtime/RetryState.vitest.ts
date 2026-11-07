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
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Queue,
  Random,
  Schema,
  Stream,
} from 'effect';
import { TestClock } from 'effect/testing';
import { layer } from '@effect/vitest';

import { expect } from 'vitest';
import {
  type Model,
  ModelError,
  RemoteOperationSchema,
  ResolvedTurnSchema,
} from '@texra-ai/llm';

// Local imports
import { qualifyAggregateId, type RunId } from '@texra-ai/harness/schemas';
import { ModelInvoker } from '@agent/runtime/ModelInvoker';
import type { InvokeRequest } from '@agent/runtime/run/requestContext';
import { appendRow, positionRow } from '@agent/runtime/loop/rows';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import {
  RunHistory,
  type RunCell,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import { freshRunState } from '@shared/session/runState';
import {
  publishTestRows,
  setTestApprovalPolicy,
  seedRows,
} from '@test/support/sessionTestUtils';
import {
  agentRunTestLayer,
  scriptedInvokerLayer,
  scriptedModel,
  startedRun,
  testBinding,
  textTurn,
} from '@test/support/scriptedRunLayers';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { noHttpClientLayer } from '@test/support/fetchTestUtils';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';

// Local file imports
import { autoDecideRequests } from '../progressTestUtils';
import type { BoundModel } from '@texra-ai/harness/plugins';

/** A draw at the middle of [0, 1): the gate's ±20 % jitter scales by exactly
 *  1, so a cooled route waits out its exact backoff (1 s, doubling). */
const MIDPOINT_RANDOM: Random.Random = {
  nextDoubleUnsafe: () => 0.5,
  nextIntUnsafe: () => 0,
};

const REQUEST: InvokeRequest = {
  system: undefined,
  tools: [],
  toolChoice: 'auto',
};

/** A failure as llm raises it over a provider's reply status. */
const httpError = (message: string, status: number): ModelError =>
  new ModelError({ kind: 'provider-rejection', message, status });

interface InvokerKit {
  readonly runId: RunId;
  /** The run's cell, holding the folded state of the freshly opened run. */
  readonly cell: RunCell;
  /** `ModelInvoker` over this run, with nothing left to provide. */
  readonly layer: Layer.Layer<ModelInvoker | SessionServices>;
}

/**
 * Open an active run the way the tool-use loop does, with its `opening`
 * messages, and the production invoker that writes to it over `model`,
 * bound as `bound` says.
 */
const openRun = Effect.fn('openRun')(function* (
  session: Context.Context<SessionServices>,
  model: Model,
  bound: Partial<BoundModel> = {},
  opening: Parameters<typeof appendRow>[1] = [
    { role: 'user', content: [{ kind: 'text', text: 'go' }] },
  ],
) {
  const runId = yield* startedRun(session);
  yield* publishTestRows(session, [
    { type: 'run.activate', aggregateId: qualifyAggregateId('run', runId) },
  ]);
  const cell = yield* Context.get(session, RunHistory).open(runId, {
    activation: () => Effect.succeed([]),
  });
  yield* cell.append([
    appendRow(runId, opening),
    positionRow(runId, freshRunState(0), 'turn.ready'),
  ]);
  const layer = scriptedInvokerLayer.pipe(
    Layer.provideMerge(agentRunTestLayer({ runId, session, model, bound })),
  );
  return { runId, cell, layer } satisfies InvokerKit;
});

/**
 * The case's test clock, which tells the case each delay the invocation
 * starts to wait out: the case advances it by exactly that much.
 */
const observedWaits = Effect.gen(function* () {
  const clock = yield* TestClock.testClockWith(Effect.succeed);
  const waits = yield* Queue.unbounded<number>();
  const observed: Clock.Clock = {
    ...clock,
    sleep: (duration) =>
      Queue.offer(waits, Duration.toMillis(duration)).pipe(
        Effect.andThen(clock.sleep(duration)),
      ),
  };
  return { clock: observed, next: Queue.take(waits) };
});

/** One invocation on an opened run, on `clock` when given. */
const invokeOn = ({ layer, cell }: InvokerKit, clock?: Clock.Clock) =>
  Effect.gen(function* () {
    const invoker = yield* ModelInvoker;
    return yield* invoker.invoke(cell, REQUEST);
  }).pipe(
    // `invoke`'s debug-object sink writes through the process `FileSystem`;
    // this suite runs on `it.effect`'s own runtime, so the service comes from
    // the Node layer rather than the installed platform.
    Effect.provide(layer),
    Effect.provide(nodePlatformLayer),
    Effect.provide(noHttpClientLayer),
    Effect.provideService(Random.Random, MIDPOINT_RANDOM),
    clock === undefined
      ? (effect) => effect
      : Effect.provideService(Clock.Clock, clock),
  );

/** The kinds of the run's `model.message` rows, in commit order. */
const modelMessages = (
  session: Context.Context<SessionServices>,
  runId: RunId,
) =>
  Effect.map(
    Context.get(session, SessionLog).history(qualifyAggregateId('run', runId)),
    (rows) =>
      rows.flatMap((row) =>
        row.type === 'model.message' ? [row.payload] : [],
      ),
  );

// Live clock for the session graph and the sessions it opens, as on the
// process runtime; each case brings its own host and test clock.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'ModelInvoker retry',
  (it) => {
    it.layer(Layer.merge(FakeHost.layer({}), TestClock.layer()), {
      buildPerTest: true,
    })((it) => {
      // The binding's budget bounds the automatic batch; the human gate opens
      // only once it is spent. The authorized attempt waits out the cooldown
      // the failed attempt opened on its route.
      it.effect('admits a manual retry through a durable approval', () =>
        Effect.gen(function* () {
          const session = yield* isolatedTestSession();
          const requests = yield* autoDecideRequests(session, () => ({
            action: 'retry',
          }));
          const stub = scriptedModel([
            httpError('temporary provider failure', 503),
            textTurn('recovered'),
          ]);
          const waits = yield* observedWaits;

          const kit = yield* openRun(session, stub.model, {
            automaticRetries: 0,
          });
          const { runId } = kit;
          const invocation = yield* Effect.forkChild(
            invokeOn(kit, waits.clock),
          );
          expect(yield* waits.next).toBe(1000);
          expect(stub.attempts()).toBe(1);
          yield* TestClock.adjust(1000);
          const outcome = yield* Fiber.join(invocation);
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
              model: 'test-model',
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
            Context.get(session, SessionViewAccess).run(runId)?.position,
          ).toBe('running');
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
            yield* setTestApprovalPolicy('yolo');
            const stub = scriptedModel([
              new ModelError({
                kind: 'transport',
                message: 'stream dropped before first token',
              }),
            ]);

            const kit = yield* openRun(session, stub.model, {
              automaticRetries: 0,
            });
            const outcome = yield* invokeOn(kit);

            expect(outcome.kind).toBe('failed');
            // The failure opened a retry request, so the policy's denial is
            // what ended the invocation, not a stop that never asked.
            const failed = (yield* modelMessages(session, kit.runId)).find(
              (payload) => payload.kind === 'failed',
            );
            expect(failed?.kind === 'failed' && failed.next.kind).toBe('ask');
            // A denial is not a cancel: the run stays running so the failure
            // can terminalize (#7331).
            expect(
              Context.get(session, SessionViewAccess).run(kit.runId)?.position,
            ).toBe('running');
            expect(stub.attempts()).toBe(1);
          }),
      );

      // Failure mode (#14259): media added since the last counted response
      // estimated 0 tokens, so a PDF the window cannot hold was sent, and
      // billed, for the provider to refuse.
      it.effect('refuses, unsent, a PDF the context window cannot hold', () =>
        Effect.gen(function* () {
          const session = yield* isolatedTestSession();
          const stub = scriptedModel([textTurn('read')]);
          const pdf = Buffer.from('%PDF-1.7').toString('base64');

          const kit = yield* openRun(
            session,
            stub.model,
            { config: buildTestModelConfig({ contextWindow: 1_000 }) },
            [
              {
                role: 'user',
                content: [
                  { kind: 'text', text: 'Summarize this.' },
                  {
                    kind: 'document',
                    mimeType: 'application/pdf',
                    base64: pdf,
                  },
                ],
              },
            ],
          );
          const outcome = yield* invokeOn(kit);

          expect(outcome.kind).toBe('failed');
          expect(stub.attempts()).toBe(0);
        }),
      );

      // Each automatic resend waits out the route's cooldown, which doubles
      // per failure; the budget spent, the run asks.
      it.effect('stops automatic attempts at the configured limit', () =>
        Effect.gen(function* () {
          const session = yield* isolatedTestSession();
          const requests = yield* autoDecideRequests(session, () => ({
            action: 'deny',
            reason: 'Denied by the approval policy.',
          }));
          const stub = scriptedModel([httpError('busy', 503)]);
          const waits = yield* observedWaits;

          const kit = yield* openRun(session, stub.model, {
            automaticRetries: 3,
          });
          const invocation = yield* Effect.forkChild(
            invokeOn(kit, waits.clock),
          );
          for (const backoff of [1000, 2000, 4000]) {
            expect(yield* waits.next).toBe(backoff);
            yield* TestClock.adjust(backoff);
          }
          yield* Fiber.join(invocation);

          expect(stub.attempts()).toBe(4);
          expect(requests.opened).toHaveLength(1);
        }),
      );

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
            const stub = scriptedModel([
              'hang',
              'hang',
              textTurn('sent again'),
            ]);
            // The model tells the case each attempt it starts to serve.
            const sent = yield* Queue.unbounded<void>();
            const model: Model = {
              ...stub.model,
              streamTurn: (turn) =>
                Stream.unwrap(
                  Effect.as(
                    Queue.offer(sent, undefined),
                    stub.model.streamTurn(turn),
                  ),
                ),
            };
            const kit = yield* openRun(session, model, {
              automaticRetries: 1,
            });
            // Each open sends one attempt, and the process stops while it runs.
            let cell = kit.cell;
            for (const _open of [1, 2]) {
              const fiber = yield* Effect.forkChild(invokeOn({ ...kit, cell }));
              yield* Queue.take(sent);
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

      // Failure modes: a user stop leaves the remote job billing; a
      // cancelled operation is re-observed on resume; a shutdown (or any
      // interrupt without a `user` stop reason) cancels work a resume should
      // pick back up.
      it.effect(
        'cancels an observed background response on a user stop, never on shutdown',
        () =>
          Effect.gen(function* () {
            const session = yield* isolatedTestSession();
            const foreground = scriptedModel([textTurn('unused')]).model;
            const operation = Schema.decodeUnknownSync(RemoteOperationSchema)({
              origin: testBinding(foreground).origin,
              providerResponseId: 'resp-background',
            });
            const scenario = Effect.fn('scenario')(function* (
              reason: 'user' | 'shutdown',
            ) {
              const calls = { submit: 0, observe: 0, cancel: 0 };
              const observing = yield* Deferred.make<void>();
              const model: Model = {
                prepareTurn: (request) =>
                  Effect.map(foreground.prepareTurn(request), (turn) =>
                    Schema.decodeUnknownSync(ResolvedTurnSchema)({
                      ...turn,
                      mode: 'background',
                    }),
                  ),
                streamTurn: () => Stream.die('no foreground turn'),
                background: {
                  submit: () =>
                    Effect.sync(() => {
                      calls.submit += 1;
                      return calls.submit === 1
                        ? {
                            kind: 'accepted' as const,
                            operation,
                            returnedModel: null,
                          }
                        : {
                            kind: 'completed' as const,
                            result: textTurn('fresh'),
                          };
                    }),
                  observe: () => {
                    calls.observe += 1;
                    return calls.observe === 1
                      ? Stream.fromEffect(
                          Deferred.succeed(observing, undefined),
                        ).pipe(Stream.drain, Stream.concat(Stream.never))
                      : Stream.make({
                          kind: 'completed' as const,
                          result: textTurn('observed'),
                        });
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
              // The stop's `run.stop` row, committed before the fiber is
              // interrupted, as `RunsShape.stop` commits it: what the
              // interrupted invocation reads its reason from.
              yield* seedRows(Context.get(session, SessionLog))([
                {
                  type: 'run.stop',
                  aggregateId: qualifyAggregateId('run', kit.runId),
                  reason,
                },
              ]);
              yield* Fiber.interrupt(fiber);
              // What a resume reads: whether the stop retired the operation.
              const stopped = (yield* modelMessages(session, kit.runId)).map(
                (payload) => payload.kind,
              );
              const resumed = yield* invokeOn({
                ...kit,
                cell: yield* Context.get(session, RunHistory).open(kit.runId),
              });
              return { calls, stopped, resumed };
            });

            const user = yield* scenario('user');
            expect(user.stopped).toEqual([
              'append',
              'attempt',
              'identified',
              'accepted',
              'cancelled',
            ]);
            // The resume submits anew instead of observing the cancelled work.
            expect(user.calls).toEqual({ submit: 2, observe: 1, cancel: 1 });
            expect(user.resumed.kind).toBe('response');

            const shutdown = yield* scenario('shutdown');
            expect(shutdown.stopped).toEqual([
              'append',
              'attempt',
              'identified',
              'accepted',
            ]);
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
