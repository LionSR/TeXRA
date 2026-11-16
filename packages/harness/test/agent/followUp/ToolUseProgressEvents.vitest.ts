// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Layer, Context } from 'effect';
import { describe, expect } from 'vitest';
import { ModelError } from '@texra-ai/llm';

// Local imports
import { MESSAGE_TYPES, RUN_OUTCOME } from '@texra-ai/harness/schemas';
import { TraceEmitter } from '@agent/trace/TraceEmitter';
import type { AgentEvent } from '@shared/session/agentEvent';
import { openToolUse, runToolUse } from '@agent/runtime/loop/runLoop';
import { RunHistory, SessionLog } from '@shared/session/runHistory';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  agentRunTestLayer,
  scriptedInvokerLayer,
  scriptedModel,
  startedRun,
  textTurn,
  toolCallTurn,
  type ScriptedRunInit,
  type ScriptedAttempt,
} from '@test/support/scriptedRunLayers';
import { isolatedTestSession, SessionGraph } from '@test/support/testKernel';

// ---------------------------------------------------------------------------
// The loop harness: the run's own services over a real session run history, with
// a scripted `Model` under the production invoker, which writes the rows, so the turn's own decisions — the blank-turn retry, the
// terminal-tool turn, the stage it opens and closes — run against the durable
// facts a live turn leaves behind.
// ---------------------------------------------------------------------------

interface LoopInit extends Omit<ScriptedRunInit, 'model'> {
  readonly script: readonly ScriptedAttempt[];
}

/** Run one scripted tool-use run to completion, with what it asked for. */
const runScript = Effect.fn('test.runScript')(function* (init: LoopInit) {
  const { model, attempts } = scriptedModel(init.script);
  const result = yield* Effect.flatMap(
    openToolUse({ resume: false }),
    (opened) => runToolUse({ resume: false }, opened),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        scriptedInvokerLayer,
        nativeToolTestLayer({
          run: { runId: init.runId, session: init.session, toolPolicy: {} },
        }),
      ).pipe(
        Layer.provideMerge(
          agentRunTestLayer({ stopAfterCycle: true, ...init, model }),
        ),
        Layer.provideMerge(
          Layer.succeed(RunHistory)(Context.get(init.session, RunHistory)),
        ),
      ),
    ),
  );
  const state = yield* Context.get(init.session, RunHistory)
    .load(init.runId)
    .pipe(Effect.orDie);
  return { result, attempts, state };
});

const quietSession = () => isolatedTestSession({ emit: () => {} });

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'tool-use progress events',
  (it) => {
    describe('the tool-use turn', () => {
      // Failure mode: a script run (a task's recipe) launched with media on
      // a vision model opened with no user message, since its launch left
      // the echo to a loop branch the script path never reached.
      it.effect(
        'opens a script run launched with media with its instruction',
        () =>
          Effect.gen(function* () {
            const session = yield* quietSession();
            const runId = yield* startedRun(session);
            const events: AgentEvent[] = [];
            yield* openToolUse({ resume: false }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  scriptedInvokerLayer,
                  nativeToolTestLayer({
                    run: { runId, session, toolPolicy: {} },
                  }),
                ).pipe(
                  Layer.provideMerge(
                    agentRunTestLayer({
                      runId,
                      session,
                      model: scriptedModel([]).model,
                      logger: new TraceEmitter((event) => events.push(event)),
                      mediaFiles: ['figure.png'],
                      scriptCall: {
                        code: 'return 1;',
                        title: 'draft',
                        tools: [],
                        kind: 'recipe',
                        block: 'task',
                        options: {},
                      },
                    }),
                  ),
                  Layer.provideMerge(
                    Layer.succeed(RunHistory)(Context.get(session, RunHistory)),
                  ),
                ),
              ),
            );
            expect(
              events.filter(
                (event) =>
                  event.type === 'log' &&
                  event.messageType === MESSAGE_TYPES.USER_MESSAGE,
              ),
            ).toMatchObject([{ message: 'Do the thing.' }]);
          }),
      );

      it.effect(
        'keeps the text of an earlier turn when a later model turn fails',
        () =>
          Effect.gen(function* () {
            // A failed run still reports what the model had said: the text
            // that accompanied the tool calls is the run's response, beside
            // the error.
            const session = yield* quietSession();

            const { result } = yield* runScript({
              runId: yield* startedRun(session),
              session,
              tools: {
                probe: {
                  definition: { name: 'probe' },
                  call: () =>
                    Effect.succeed({
                      status: 'executed' as const,
                      output: 'done',
                    }),
                },
              },
              script: [
                toolCallTurn(
                  [{ id: 'call-1', name: 'probe' }],
                  'I checked the tool.',
                ),
                new ModelError({
                  kind: 'invalid-request',
                  message: 'Later provider failure',
                }),
              ],
            });

            expect(result).toMatchObject({
              outcome: RUN_OUTCOME.FAILED,
              output: { response: 'I checked the tool.' },
              failure: {
                kind: 'model',
                failure: { message: 'Later provider failure' },
              },
            });
          }),
      );

      // Failure mode (#14259): a request the model's window could not hold
      // failed the run; the history is compacted once and the request sent
      // again.
      it.effect('compacts and asks again after the window overflowed', () =>
        Effect.gen(function* () {
          const session = yield* quietSession();
          const runId = yield* startedRun(session);
          const { result } = yield* runScript({
            runId,
            session,
            tools: {
              probe: {
                definition: { name: 'probe' },
                call: () =>
                  Effect.succeed({
                    status: 'executed' as const,
                    output: 'done',
                  }),
              },
            },
            script: [
              toolCallTurn([{ id: 'call-1', name: 'probe' }], 'Checking.'),
              new ModelError({
                kind: 'context-overflow',
                message:
                  "Input is 300000 tokens, which exceeds the model's context window of 200000 tokens.",
              }),
              textTurn('The user asked for a check; the probe ran.'),
              textTurn('The check passed.'),
            ],
          });
          expect(result).toMatchObject({
            outcome: RUN_OUTCOME.COMPLETED,
            output: { response: 'The check passed.' },
          });
          const edits = yield* Context.get(session, SessionLog).history(
            runId,
            undefined,
            ['context.edit'],
          );
          expect(edits).toMatchObject([
            { type: 'context.edit', payload: { trigger: 'overflow' } },
          ]);
        }),
      );

      // Failure mode: a turn the model's output limit ended early was
      // finalized as a complete answer, and nothing shown said so.
      it.effect('names the limit that ended an answer early', () =>
        Effect.gen(function* () {
          const session = yield* quietSession();
          const runId = yield* startedRun(session);
          const { result } = yield* runScript({
            runId,
            session,
            tools: {},
            script: [textTurn('The proof begins with the', 'length')],
          });
          expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
          const finalized = yield* Context.get(session, SessionLog).history(
            runId,
            undefined,
            ['response.finalized'],
          );
          expect(finalized).toMatchObject([
            { type: 'response.finalized', cut: 'length' },
          ]);
        }),
      );
    });
  },
);
