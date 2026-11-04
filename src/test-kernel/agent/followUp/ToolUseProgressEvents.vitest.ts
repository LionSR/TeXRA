// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Layer, Context } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { qualifyAggregateId, RUN_OUTCOME } from '@texra-ai/harness/schemas';
import type { InvokeRequest } from '@agent/runtime/run/requestContext';
import { runToolUse } from '@agent/runtime/loop/toolUse';
import { RunHistory, SessionLog } from '@shared/session/runHistory';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  agentRunTestLayer,
  scriptedInvokerLayer,
  startedRun,
  textTurn,
  toolCallTurn,
  type ScriptedRunInit,
  type ScriptedTurn,
} from '@test/support/scriptedRunLayers';
import { isolatedTestSession, SessionGraph } from '@test/support/testKernel';

import type { ITool } from '@texra-ai/harness';

// ---------------------------------------------------------------------------
// The loop harness: the run's own services over a real session run history, with
// the model faked at the `ModelInvoker` seam. The rows the fake writes are the
// production ones, so the turn's own decisions — the blank-turn retry, the
// terminal-tool turn, the stage it opens and closes — run against the durable
// facts a live turn leaves behind.
// ---------------------------------------------------------------------------

interface LoopInit extends ScriptedRunInit {
  readonly script: readonly ScriptedTurn[];
}

/** Run one scripted tool-use run to completion, with what it asked for. */
const runScript = Effect.fn('test.runScript')(function* (init: LoopInit) {
  const requests: InvokeRequest[] = [];
  const result = yield* runToolUse({ resume: false }).pipe(
    Effect.provide(
      Layer.mergeAll(
        scriptedInvokerLayer(init.script, requests),
        nativeToolTestLayer(),
      ).pipe(
        Layer.provideMerge(
          agentRunTestLayer({ stopAfterCycle: true, ...init }),
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
  return { result, requests, state };
});

const quietSession = () => isolatedTestSession({ emit: () => {} });

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'tool-use progress events',
  (it) => {
    describe('the tool-use turn', () => {
      it.effect(
        'keeps the text of an earlier turn when a later model turn fails',
        () =>
          Effect.gen(function* () {
            // A failed run still reports what the model had said: the text
            // that accompanied the tool calls is the run's response, beside
            // the error.
            const session = yield* quietSession();

            const { result } = yield* runScript({
              runId: startedRun(session),
              session,
              tools: {
                probe: {
                  definition: { name: 'probe' },
                  call: () =>
                    Effect.succeed({
                      status: 'executed' as const,
                      output: 'done',
                    }),
                } as ITool,
              },
              script: [
                toolCallTurn(
                  [{ id: 'call-1', name: 'probe' }],
                  'I checked the tool.',
                ),
                {
                  failWith: {
                    message: 'Later provider failure',
                  },
                },
              ],
            });

            expect(result).toMatchObject({
              outcome: RUN_OUTCOME.FAILED,
              output: { response: 'I checked the tool.' },
              failure: { message: 'Later provider failure' },
            });
          }),
      );

      // Failure mode (#14259): a request the model's window could not hold
      // failed the run; the history is compacted once and the request sent
      // again.
      it.effect('compacts and asks again after the window overflowed', () =>
        Effect.gen(function* () {
          const session = yield* quietSession();
          const runId = startedRun(session);
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
              } as ITool,
            },
            script: [
              toolCallTurn([{ id: 'call-1', name: 'probe' }], 'Checking.'),
              {
                failWith: {
                  message:
                    "Input is 300000 tokens, which exceeds the model's context window of 200000 tokens.",
                  classification: { kind: 'context-window' },
                },
              },
              { summary: 'The user asked for a check; the probe ran.' },
              textTurn('The check passed.'),
            ],
          });
          expect(result).toMatchObject({
            outcome: RUN_OUTCOME.COMPLETED,
            output: { response: 'The check passed.' },
          });
          const edits = yield* Context.get(session, SessionLog).history(
            qualifyAggregateId('run', runId),
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
          const runId = startedRun(session);
          const { result } = yield* runScript({
            runId,
            session,
            tools: {},
            script: [textTurn('The proof begins with the', 'length')],
          });
          expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
          const finalized = yield* Context.get(session, SessionLog).history(
            qualifyAggregateId('run', runId),
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
