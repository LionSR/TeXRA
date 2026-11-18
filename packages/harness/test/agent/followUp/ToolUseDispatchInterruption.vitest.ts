// Third-party imports
import { join } from 'node:path';

import { layer } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Queue, Context } from 'effect';
import { assert, expect, vi } from 'vitest';

// Local imports
import { generateRunId } from '@texra-ai/harness/schemas';
import { openToolUse, runToolUse } from '@agent/runtime/loop/runLoop';
import { RunHistory } from '@shared/session/runHistory';
import type { RunState } from '@shared/session/runState';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  agentRunTestLayer,
  scriptedInvokerLayer,
  scriptedModel,
  textTurn,
  toolCallTurn,
  type ScriptedRunInit,
} from '@test/support/scriptedRunLayers';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  crashAt,
  persistentTestSession,
  readStoreSnapshot,
  storedRows,
} from '@test/support/storeFaults';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';
import type { ITool } from '@texra-ai/harness/plugins';

import type { Model, TurnResult } from '@texra-ai/llm';

// ---------------------------------------------------------------------------
// The loop harness: the run's own services over a real session run history, with
// a scripted `Model` under the production invoker, which writes the rows, so the fold, the resume rules and dispatch all run against
// the durable facts a live turn leaves behind.
// ---------------------------------------------------------------------------

interface HarnessInit extends Omit<ScriptedRunInit, 'model'> {
  readonly tools: Record<string, ITool>;
  readonly turns: readonly TurnResult[];
  /** The model to serve, when the case counts its attempts. */
  readonly model?: Model;
}

/** The calls a folded state holds settled. */
const settledIds = (state: RunState | null | undefined): string[] =>
  Object.entries(state?.pendingResponse?.records ?? {}).flatMap(([id, call]) =>
    call.status.kind === 'finished' ? [id] : [],
  );

function loopLayer(init: HarnessInit) {
  return Layer.mergeAll(
    scriptedInvokerLayer,
    nativeToolTestLayer({
      run: { runId: init.runId, session: init.session, toolPolicy: {} },
    }),
  ).pipe(
    Layer.provideMerge(
      agentRunTestLayer({
        ...init,
        model: init.model ?? scriptedModel(init.turns).model,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(RunHistory)(Context.get(init.session, RunHistory)),
    ),
  );
}

/** A barrier tool whose call never settles, so a stop catches it in flight. */
function blockingTool(name: string) {
  const started = Deferred.makeUnsafe<void>();
  const call = vi.fn(() =>
    Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
  );

  const tool: ITool = { call, definition: { name } };
  return { call, started: Deferred.await(started), tool };
}

/** The commit of the run's delivering `append`: its tool results. */
const deliveryCommit = (storage: string) => {
  const delivery = storedRows(storage).find((row) => {
    // cast: a `model.message` row's data holds its payload's kind and source.
    const { payload } = JSON.parse(row.data) as {
      payload: { kind?: string; sourceResponse?: string | null };
    };
    return (
      row.type === 'model.message' &&
      payload.kind === 'append' &&
      payload.sourceResponse != null
    );
  });
  assert(delivery !== undefined);
  return delivery.commit;
};

function executedTool(name: string) {
  const call = vi.fn(() =>
    Effect.succeed({ status: 'executed' as const, output: `${name} done` }),
  );
  const tool: ITool = { call, definition: { name } };
  return { call, tool };
}

/**
 * Regression cover for https://github.com/LionSR/TeXRA/issues/7163.
 *
 * An assistant turn persisted with N tool_use blocks and fewer than N
 * tool_result entries is unresumable: providers with strict pairing (and
 * OpenAI's response chaining) refuse the next request. The retired engine
 * defended this by synthesizing cancelled results at the interrupt. The
 * run history defends it by construction: a response that requested tools enters
 * the conversation only through the delivering `append`, which carries the
 * complete tool group, so an interrupt mid-dispatch leaves no assistant tool
 * turn in history at all and the settled calls stay row facts. Resume settles
 * what is left and delivers the group once.
 */
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'tool dispatch interrupted mid-turn',
  (it) => {
    it.effect(
      'leaves no half-delivered tool turn in history, and resume pairs every call',
      () =>
        Effect.gen(function* () {
          const session = yield* isolatedTestSession({ emit: () => {} });
          const runId = generateRunId();
          yield* publishTestRunStart(session, runId);
          const toolA = executedTool('toolA');
          const toolB = blockingTool('toolB');
          const toolC = executedTool('toolC');
          const tools = {
            toolA: toolA.tool,
            toolB: toolB.tool,
            toolC: toolC.tool,
          };

          const fiber = yield* Effect.forkDetach(
            Effect.flatMap(openToolUse({ resume: false }), (opened) =>
              runToolUse({ resume: false }, opened),
            ).pipe(
              Effect.provide(
                loopLayer({
                  runId,
                  session,
                  tools,
                  turns: [
                    toolCallTurn([
                      { id: 'call-a', name: 'toolA' },
                      { id: 'call-b', name: 'toolB' },
                      { id: 'call-c', name: 'toolC' },
                    ]),
                  ],
                  stopAfterCycle: true,
                }),
              ),
            ),
          );
          yield* toolB.started;
          yield* Fiber.interrupt(fiber);

          // call-a settled before the stop, call-b was in flight, call-c is a
          // later barrier that never started.
          const interrupted = yield* Context.get(session, RunHistory)
            .load(runId)
            .pipe(Effect.orDie);
          // No assistant tool turn and no tool group: the paid response is
          // pending, with the one call that settled recorded against it.
          expect(interrupted?.messages.map((message) => message.role)).toEqual([
            'user',
          ]);
          expect(settledIds(interrupted)).toEqual(['call-a']);

          const resumed = yield* Effect.flatMap(
            openToolUse({ resume: true }),
            (opened) => runToolUse({ resume: true }, opened),
          ).pipe(
            Effect.provide(
              loopLayer({
                runId,
                session,
                tools,
                turns: [textTurn('All three calls are accounted for.')],
                stopAfterCycle: true,
              }),
            ),
          );
          expect(resumed.outcome).toBe('completed');

          // The call whose body started is not re-run blind: it settles as
          // outcome unknown, and the model decides from that.
          expect(toolB.call).toHaveBeenCalledTimes(1);
          // The call that never started is not run blind: the model is told
          // so and decides whether to retry it.
          expect(toolC.call).not.toHaveBeenCalled();

          const delivered = yield* Context.get(session, RunHistory)
            .load(runId)
            .pipe(Effect.orDie);
          const group = delivered?.messages.find(
            (message) => message.role === 'tool',
          );
          // Every requested call is paired exactly once, in call order.
          expect(group?.role === 'tool' ? group.results.length : 0).toBe(3);
          expect(
            group?.role === 'tool' ? JSON.stringify(group.results[1]) : '',
          ).toContain('Its outcome is unknown');
          expect(delivered?.pendingResponse).toBeNull();
        }),
    );

    /**
     * Failure mode: a replay-safe call a person stopped, or an app close cut,
     * three times is refused on its fourth start, though every resume is a
     * person's act.
     */
    it.effect('replays a replay-safe call however often it was cut short', () =>
      Effect.gen(function* () {
        const session = yield* isolatedTestSession({ emit: () => {} });
        const runId = generateRunId();
        yield* publishTestRunStart(session, runId);
        const starts = yield* Queue.unbounded<void>();
        // The first three starts never finish; a fourth would.
        let started = 0;
        const call = vi.fn(() => {
          started += 1;
          return started <= 3
            ? Queue.offer(starts, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed({
                status: 'executed' as const,
                output: 'fourth start finished',
              });
        });
        const tools: Record<string, ITool> = {
          toolB: {
            call,
            definition: { name: 'toolB' },
            replay: 'safe',
          },
        };
        const run = (resume: boolean, turns: readonly TurnResult[]) =>
          Effect.flatMap(openToolUse({ resume }), (opened) =>
            runToolUse({ resume }, opened),
          ).pipe(
            Effect.provide(
              loopLayer({ runId, session, tools, turns, stopAfterCycle: true }),
            ),
          );
        const issued = [toolCallTurn([{ id: 'call-b', name: 'toolB' }])];
        for (const resume of [false, true, true]) {
          const fiber = yield* Effect.forkDetach(
            run(resume, resume ? [] : issued),
          );
          yield* Queue.take(starts);
          yield* Fiber.interrupt(fiber);
        }

        const resumed = yield* run(true, [textTurn('It ran.')]);
        expect(resumed.outcome).toBe('completed');
        expect(call).toHaveBeenCalledTimes(4);
        const delivered = yield* Context.get(session, RunHistory)
          .load(runId)
          .pipe(Effect.orDie);
        const group = delivered?.messages.find(
          (message) => message.role === 'tool',
        );
        expect(
          group?.role === 'tool' ? JSON.stringify(group.results[0]) : '',
        ).toContain('fourth start finished');
      }),
    );

    /**
     * Failure mode: a crash after the `append` that delivers a turn-ending
     * result (`submit_output`'s) and before the turn's end is recorded
     * resumes into the turn and pays for one more model request.
     */
    it.effect(
      'a turn its delivered results ended stays ended across a crash before its end is recorded',
      () =>
        Effect.gen(function* () {
          const { roots } = yield* FakeHost;
          const clean = join(roots.storage, 'clean');
          const runId = generateRunId();
          const tools: Record<string, ITool> = {
            finish: {
              call: () =>
                Effect.succeed({
                  status: 'executed' as const,
                  output: 'submitted',
                  endTurn: true,
                }),
              definition: { name: 'finish' },
            },
          };
          const committed = join(roots.storage, 'committed.db');
          yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* persistentTestSession({
                ...roots,
                storage: clean,
              });
              yield* publishTestRunStart(session, runId);
              const done = yield* Effect.flatMap(
                openToolUse({ resume: false }),
                (opened) => runToolUse({ resume: false }, opened),
              ).pipe(
                Effect.provide(
                  loopLayer({
                    runId,
                    session,
                    tools,
                    turns: [toolCallTurn([{ id: 'call-1', name: 'finish' }])],
                    stopAfterCycle: true,
                  }),
                ),
              );
              expect(done.outcome).toBe('completed');
              readStoreSnapshot(clean, (db) =>
                db.exec(`VACUUM INTO '${committed}'`),
              );
            }),
          );

          // The process died once the results were delivered.
          const cut = join(roots.storage, 'cut');
          crashAt(committed, cut, deliveryCommit(clean));
          const session = yield* persistentTestSession({
            ...roots,
            storage: cut,
          });
          const model = scriptedModel([textTurn('Asked again.')]);
          const resumed = yield* Effect.flatMap(
            openToolUse({ resume: true }),
            (opened) => runToolUse({ resume: true }, opened),
          ).pipe(
            Effect.provide(
              loopLayer({
                runId,
                session,
                tools,
                turns: [],
                model: model.model,
                stopAfterCycle: true,
              }),
            ),
          );
          expect(resumed.outcome).toBe('completed');
          expect(model.attempts()).toBe(0);
        }),
    );
  },
);
