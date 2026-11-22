// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Layer, Context } from 'effect';
import { assert, describe, expect } from 'vitest';
import { ModelError } from '@texra-ai/llm';

// Local imports
import { MESSAGE_TYPES, RUN_OUTCOME } from '@texra-ai/worldline/schemas';
import { TraceEmitter } from '@agent/trace/TraceEmitter';
import type { AgentEvent } from '@shared/session/agentEvent';
import { openToolUse, runToolUse } from '@agent/runtime/loop/runLoop';
import { RunHistory, SessionLog } from '@shared/session/runHistory';
import { ContextTool } from '@tools/codemode/ContextTool';
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
  const result = yield* Effect.flatMap(openToolUse(), runToolUse).pipe(
    Effect.provide(
      scriptedInvokerLayer.pipe(
        Layer.provideMerge(
          nativeToolTestLayer({
            run: { runId: init.runId, session: init.session, toolPolicy: {} },
          }),
        ),
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
      // Failure mode: a script run (a background script) launched with media on
      // a vision model opened with no user message, since its launch left
      // the echo to a loop branch the script path never reached.
      it.effect(
        'opens a script run launched with media with its instruction',
        () =>
          Effect.gen(function* () {
            const session = yield* quietSession();
            const runId = yield* startedRun(session);
            const events: AgentEvent[] = [];
            yield* openToolUse().pipe(
              Effect.provide(
                scriptedInvokerLayer.pipe(
                  Layer.provideMerge(
                    nativeToolTestLayer({
                      run: { runId, session, toolPolicy: {} },
                    }),
                  ),
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
                        kind: 'background',
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

      // Failure modes of a threshold summary: it summarized the summary an
      // earlier one left, so a long run's early history was rewritten at
      // every compaction; and it kept the newest exchange alone, so the
      // model lost the wording of everything else it had just read.
      it.effect(
        'a threshold summary keeps earlier summaries and the newest messages',
        () =>
          Effect.gen(function* () {
            const session = yield* quietSession();
            const runId = yield* startedRun(session);
            // Each result is about 20k tokens of the 200k window: the
            // threshold (150k) is passed after eight of them, and the tail
            // it leaves (50k) holds two.
            const probe = {
              definition: { name: 'probe' },
              call: () =>
                Effect.succeed({
                  status: 'executed' as const,
                  output: 'x'.repeat(80_000),
                }),
            };
            const probes = (from: number, to: number) =>
              Array.from({ length: to - from + 1 }, (_, i) =>
                toolCallTurn([{ id: `call-${from + i}`, name: 'probe' }]),
              );
            const { result, state } = yield* runScript({
              runId,
              session,
              tools: { probe },
              script: [
                ...probes(1, 8),
                textTurn('First summary.'),
                ...probes(9, 14),
                textTurn('Second summary.'),
                textTurn('Done.'),
              ],
            });
            expect(result).toMatchObject({
              outcome: RUN_OUTCOME.COMPLETED,
              output: { response: 'Done.' },
            });
            const edits = yield* Context.get(session, SessionLog).history(
              runId,
              undefined,
              ['context.edit'],
            );
            // The first replaces the task and six exchanges; the second
            // starts after the first's summary.
            expect(edits).toMatchObject([
              {
                payload: {
                  trigger: 'context-limit',
                  range: { from: 0, to: 13 },
                },
              },
              {
                payload: {
                  trigger: 'context-limit',
                  range: { from: 1, to: 13 },
                },
              },
            ]);
            assert(state !== null);
            expect(
              state.messages.map((message) =>
                message.role === 'user'
                  ? message.content.flatMap((part) =>
                      part.kind === 'text' ? [part.text] : [],
                    )
                  : message.role,
              ),
            ).toEqual([
              ['[Previous conversation summary]\n\nFirst summary.'],
              ['[Previous conversation summary]\n\nSecond summary.'],
              'assistant',
              'tool',
              'assistant',
              'tool',
              'assistant',
            ]);
          }),
      );

      // Failure modes of an agent's own context edit (`context` replace):
      // a range reaching into the response that asked for it; a range that
      // leaves a tool result without its call; two ranges of one response,
      // which must both apply, highest first, each against the view the
      // response was sent with; and an overlapping one, refused. A refused
      // range changes nothing and says why.
      it.effect('applies the replacements a response asked for', () =>
        Effect.gen(function* () {
          const session = yield* quietSession();
          const runId = yield* startedRun(session);
          const probe = {
            definition: { name: 'probe' },
            call: () =>
              Effect.succeed({ status: 'executed' as const, output: 'done' }),
          };
          const replace = (id: string, from: number, to: number) => ({
            id,
            name: 'context',
            input: { action: 'replace', from, to, with: `note ${id}` },
          });
          const { result, state } = yield* runScript({
            runId,
            session,
            tools: { probe, context: ContextTool },
            script: [
              toolCallTurn([{ id: 'call-1', name: 'probe' }]),
              toolCallTurn([{ id: 'call-2', name: 'probe' }]),
              // The view: [0] the task, [1] call-1, [2] its result, [3]
              // call-2, [4] its result; this response is message 5.
              toolCallTurn([
                replace('a', 3, 5),
                replace('orphan', 1, 2),
                replace('into', 1, 6),
                replace('overlap', 4, 5),
                replace('b', 1, 3),
              ]),
              textTurn('Done.'),
            ],
          });
          expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
          const edits = yield* Context.get(session, SessionLog).history(
            runId,
            undefined,
            ['context.edit'],
          );
          expect(edits).toMatchObject([
            { payload: { cause: 'edit', range: { from: 3, to: 5 } } },
            { payload: { cause: 'edit', range: { from: 1, to: 3 } } },
          ]);
          assert(state !== null);
          expect(state.contextEdits).toEqual([]);
          const texts = state.messages.map((message) =>
            message.role === 'user'
              ? message.content.flatMap((part) =>
                  part.kind === 'text' ? [part.text] : [],
                )
              : message.role === 'tool'
                ? message.results.map(
                    ({ status, content }) =>
                      `${status}: ${content.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('')}`,
                  )
                : [message.role],
          );
          expect(texts).toEqual([
            ['Do the thing.'],
            ['[Context you replaced]\n\nnote b'],
            ['[Context you replaced]\n\nnote a'],
            ['assistant'],
            [
              expect.stringMatching(
                /^success: Messages \[3, 5\) will be replaced/,
              ),
              expect.stringMatching(
                /^error: .*separate a tool call from its result/,
              ),
              expect.stringMatching(
                /^error: .*message 5 is the response that made this call/,
              ),
              expect.stringMatching(
                /^error: .*already asked to replace \[3, 5\)/,
              ),
              expect.stringMatching(
                /^success: Messages \[1, 3\) will be replaced/,
              ),
            ],
            ['assistant'],
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
