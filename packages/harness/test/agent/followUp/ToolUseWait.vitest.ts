import { rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Fiber, Layer, Stream, Context } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { generateRunId, qualifyAggregateId } from '@texra-ai/harness/schemas';
import { appendRow, positionRow } from '@agent/runtime/loop/rows';
import { openToolUse, runToolUse } from '@agent/runtime/loop/toolUse';
import { attachedMedia } from '@agent/runtime/run/mediaInput';
import { Inbox } from '@agent/followUp/Inbox';
import { SessionRoots } from '@platform/rootedFs';
import { RunHistory, SessionLog } from '@shared/session/runHistory';
import { type RunState } from '@shared/session/runState';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  agentRunTestLayer,
  scriptedInvokerLayer,
  scriptedModel,
  startedRun,
  textTurn,
  type ScriptedModel,
  type ScriptedRunInit,
  type ScriptedAttempt,
} from '@test/support/scriptedRunLayers';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { publishTestRows } from '@test/support/sessionTestUtils';
import { isolatedTestSession, SessionGraph } from '@test/support/testKernel';

// ---------------------------------------------------------------------------
// The loop harness: the run's own services over a real session run history and the
// session's real follow-up queue, with a scripted `Model` under the production
// invoker. The wait, the drain and the consumption are the production ones, so
// what a parked run does with input is exercised end to end.
// ---------------------------------------------------------------------------

interface LoopInit extends Omit<ScriptedRunInit, 'model'> {
  readonly script: readonly ScriptedAttempt[];
  readonly resume?: boolean;
}

function loopProgram(init: LoopInit, model: ScriptedModel['model']) {
  return Effect.flatMap(
    openToolUse({ resume: init.resume === true }),
    (opened) => runToolUse({ resume: init.resume === true }, opened),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        scriptedInvokerLayer,
        nativeToolTestLayer({
          run: { runId: init.runId, session: init.session, toolPolicy: {} },
        }),
      ).pipe(
        Layer.provideMerge(agentRunTestLayer({ ...init, model })),
        Layer.provideMerge(
          Layer.succeed(RunHistory)(Context.get(init.session, RunHistory)),
        ),
      ),
    ),
  );
}

/**
 * Start a run that parks, for scenarios that drive it while it waits.
 * `park(n)` waits for the run's `n`-th committed `waiting` position from the
 * loop's start: the turn boundary, or a restored park with nothing queued.
 * Input a scenario enqueues after it lands on the queue or on a waiting
 * consumer; the wait takes what is queued first, so both orders deliver the
 * same batch.
 */
const forkLoop = Effect.fn('test.forkLoop')(function* (init: LoopInit) {
  const scripted = scriptedModel(init.script);
  const from = Context.get(init.session, SessionLog).now();
  const fiber = yield* Effect.forkChild(loopProgram(init, scripted.model));
  const run = qualifyAggregateId('run', init.runId);
  const park = (n: number) =>
    Context.get(init.session, SessionLog)
      .tail(from)
      .pipe(
        Stream.filter(
          (row) =>
            row.aggregateId === run &&
            row.type === 'run.position' &&
            row.payload.at === 'waiting',
        ),
        Stream.take(n + 1),
        Stream.runDrain,
      );
  return { fiber, attempts: scripted.attempts, park };
});

/** A 1x1 PNG. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const quietSession = () => isolatedTestSession({ emit: () => {} });

/** The plain text of every user message the run recorded. */
function userTexts(state: RunState | null): string[] {
  return (state?.messages ?? []).flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((part) =>
          part.kind === 'text' ? [part.text] : [],
        )
      : [],
  );
}

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'a run waiting for input',
  (it) => {
    describe('a parked child run', () => {
      it.effect(
        'delivers a follow-up its rows still queue exactly once, with the message it becomes (C3)',
        () =>
          Effect.gen(function* () {
            const session = yield* quietSession();
            const parentRunId = generateRunId();
            const runId = yield* startedRun(session, parentRunId);
            const asked = 'state where finiteness is used';

            const first = yield* forkLoop({
              runId,
              session,
              parentRunId,
              script: [textTurn('first cycle')],
            });
            yield* first.park(0);
            yield* Fiber.interrupt(first.fiber);
            // A crash between admission and the consuming batch leaves the row
            // and nothing else: no process holds the follow-up in memory.
            const queued = {
              type: 'followup.queued' as const,
              aggregateId: qualifyAggregateId('run', runId),
              followUpId: 'follow-up-1',
              content: { text: asked, from: { kind: 'user' as const } },
            };
            yield* publishTestRows(session, [queued]);
            yield* Context.get(session, SessionLog).settled;

            const resumed = yield* forkLoop({
              runId,
              session,
              parentRunId,
              resume: true,
              script: [textTurn('second cycle'), textTurn('never reached')],
            });
            yield* resumed.park(0);
            const resumedState = yield* Context.get(session, RunHistory).load(
              runId,
            );
            expect(userTexts(resumedState)).toContain(asked);
            expect(
              (yield* Context.get(session, Inbox).read(runId)).followUps,
            ).toEqual([]);
            yield* Fiber.interrupt(resumed.fiber);

            // A producer that replays the delivery after a restart writes the
            // same id again; it names a follow-up already consumed.
            yield* publishTestRows(session, [queued]);
            yield* Context.get(session, SessionLog).settled;
            const again = yield* forkLoop({
              runId,
              session,
              parentRunId,
              resume: true,
              script: [textTurn('never reached')],
            });
            yield* again.park(0);
            expect(again.attempts()).toBe(0);
            expect(
              userTexts(
                yield* Context.get(session, RunHistory).load(runId),
              ).filter((text) => text === asked),
            ).toEqual([asked]);
            yield* Fiber.interrupt(again.fiber);
          }),
      );

      it.effect(
        'a one-shot child resumed for a queued message runs its turn, then ends',
        () =>
          Effect.gen(function* () {
            const session = yield* quietSession();
            const parentRunId = generateRunId();
            const runId = yield* startedRun(session, parentRunId);
            const first = yield* forkLoop({
              runId,
              session,
              parentRunId,
              stopAfterCycle: true,
              script: [textTurn('first cycle')],
            });
            expect((yield* Fiber.join(first.fiber)).outcome).toBe('completed');

            // Its parent's message, queued once the child ended: the resume
            // that delivers it runs the turn it asks for, not the end alone.
            const asked = 'now check the boundary case';
            yield* publishTestRows(session, [
              {
                type: 'followup.queued' as const,
                aggregateId: qualifyAggregateId('run', runId),
                followUpId: 'follow-up-2',
                content: {
                  text: asked,
                  from: {
                    kind: 'run' as const,
                    runId: parentRunId,
                    relation: 'parent' as const,
                  },
                },
              },
            ]);
            yield* Context.get(session, SessionLog).settled;

            const resumed = yield* forkLoop({
              runId,
              session,
              parentRunId,
              stopAfterCycle: true,
              resume: true,
              script: [textTurn('second cycle')],
            });
            expect((yield* Fiber.join(resumed.fiber)).outcome).toBe(
              'completed',
            );
            expect(resumed.attempts()).toBe(1);
            expect(
              userTexts(yield* Context.get(session, RunHistory).load(runId)),
            ).toContain(asked);
          }),
      );
    });

    describe('a parked root run', () => {
      it.effect(
        'answers a follow-up consumed just before the loop exited',
        () =>
          Effect.gen(function* () {
            const session = yield* quietSession();
            const runId = yield* startedRun(session);
            const first = yield* forkLoop({
              runId,
              session,
              script: [textTurn('first')],
            });
            yield* first.park(0);
            yield* Fiber.interrupt(first.fiber);

            // The rows `FollowUps.consume` commits, and then nothing: the
            // process ended before the turn that answers them began.
            const parked = yield* Context.get(session, RunHistory)
              .load(runId)
              .pipe(Effect.orDie);
            if (parked === null) throw new Error('The run has no run history.');
            const cell = yield* Context.get(session, RunHistory).open(runId);
            yield* cell.append([
              appendRow(runId, [
                {
                  role: 'user',
                  content: [{ kind: 'text', text: 'answer me' }],
                },
              ]),
              positionRow(runId, parked, 'turn.ready'),
            ]);

            const resumed = yield* forkLoop({
              runId,
              session,
              resume: true,
              script: [textTurn('answered')],
            });
            yield* resumed.park(0);
            yield* Fiber.interrupt(resumed.fiber);

            expect(resumed.attempts()).toBe(1);
          }),
      );
    });

    describe('a follow-up with media', () => {
      // #13874: a pasted file swept from storage after its send still reaches
      // the model, which reads it from the store by address.
      it.effect('reaches the model from the store once its file is gone', () =>
        Effect.gen(function* () {
          const session = yield* quietSession();
          const runId = yield* startedRun(session);
          yield* Context.get(session, SessionLog).settled;
          const file = path.join(os.tmpdir(), `texra-${generateRunId()}.png`);
          writeFileSync(file, Buffer.from(PIXEL, 'base64'));
          const attached = yield* attachedMedia(
            [file],
            Context.get(session, SessionRoots),
          ).pipe(
            Effect.provide(Layer.merge(nodePlatformLayer, nodeSpawnerLayer)),
          );
          rmSync(file);
          yield* Context.get(session, Inbox).send(runId, {
            text: 'see the pixel',
            from: { kind: 'user' },
            ...attached,
          });

          const run = yield* forkLoop({
            runId,
            session,
            bound: { supportsVision: true },
            script: [textTurn('first'), textTurn('seen')],
          });
          yield* run.park(1);
          yield* Fiber.interrupt(run.fiber);
          const state = yield* Context.get(session, RunHistory)
            .load(runId)
            .pipe(Effect.orDie);

          const digest = attached.media?.[0]?.digest ?? '';
          expect(state?.messages).toContainEqual({
            role: 'user',
            content: [
              { kind: 'text', text: 'see the pixel' },
              { kind: 'image', mimeType: 'image/png', digest },
            ],
          });
          expect(
            (yield* Context.get(session, SessionLog).blobs([digest])).get(
              digest,
            ),
          ).toBe(PIXEL);
        }),
      );
    });
  },
);
