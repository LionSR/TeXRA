import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import { type InvokeRequest } from '@agent/runtime/ModelInvoker';
import { appendRow, rowAggregate, positionRow } from '@agent/runtime/loop/rows';
import { runToolUse } from '@agent/runtime/loop/toolUse';
import { TraceEmitter } from '@agent/trace';
import { RunHistory } from '@shared/session/runHistory';
import { type RunState } from '@shared/session/runState';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  agentRunTestLayer,
  scriptedInvokerLayer,
  startedRun,
  textTurn,
  type ScriptedRunInit,
  type ScriptedTurn,
} from '@test/support/scriptedRunLayers';
import { publishTestRows } from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';

import { sessionWithInteractions } from '../progressTestUtils';

// ---------------------------------------------------------------------------
// The loop harness: the run's own services over a real session run history and the
// session's real follow-up queue, with the model faked at the `ModelInvoker`
// seam. The wait, the drain and the consumption are the production ones, so
// what a parked run does with input is exercised end to end.
// ---------------------------------------------------------------------------

interface LoopInit extends ScriptedRunInit {
  readonly script: readonly ScriptedTurn[];
  readonly resume?: boolean;
}

function loopProgram(init: LoopInit, requests: InvokeRequest[]) {
  return runToolUse({ resume: init.resume === true }).pipe(
    Effect.provide(
      Layer.mergeAll(
        scriptedInvokerLayer(init.script, requests),
        nativeToolTestLayer({
          run: { runId: init.runId, session: init.session, toolPolicy: {} },
        }),
      ).pipe(
        Layer.provideMerge(agentRunTestLayer(init)),
        Layer.provideMerge(Layer.succeed(RunHistory)(init.session.runHistory)),
      ),
    ),
  );
}

/** Run one scripted run to its own exit. */
const runLoop = Effect.fn('test.runLoop')(function* (init: LoopInit) {
  const requests: InvokeRequest[] = [];
  const result = yield* loopProgram(init, requests);
  const state = yield* init.session.runHistory
    .load(init.runId)
    .pipe(Effect.orDie);
  return { result, requests, state };
});

/**
 * Start a run that parks, for scenarios that drive it while it waits. The
 * loop calls `onIdle` on its own fiber immediately before it blocks for
 * input, after the batch carrying the `waiting` step has committed, so one
 * Deferred per park is the loop's own 'parked for the Nth time' signal:
 * `park(n)` is what those scenarios wait on. The wait resumes
 * inside that callback, before the loop enters `followUps.wait`, so input a
 * scenario enqueues after `park` lands on the queue rather than on a waiting
 * consumer; the wait takes what is queued first, so both orders deliver the
 * same batch.
 */
const forkLoop = Effect.fn('test.forkLoop')(function* (init: LoopInit) {
  const requests: InvokeRequest[] = [];
  const parks = yield* Effect.forEach(init.script, () => Deferred.make<void>());
  let parked = 0;
  const fiber = yield* Effect.forkChild(
    loopProgram(
      {
        ...init,
        onIdle: () => {
          init.onIdle?.();
          const park = parks[parked];
          parked += 1;
          if (park) Deferred.doneUnsafe(park, Effect.void);
        },
      },
      requests,
    ),
  );
  /** Wait for the loop's `n`-th park; the n-th invocation precedes it. */
  const park = (n: number) => {
    const deferred = parks[n];
    if (!deferred) throw new Error(`The script has no park ${n}.`);
    return Deferred.await(deferred);
  };
  return { fiber, requests, park };
});

const quietSession = () => sessionWithInteractions({ emit: () => {} });

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

describe('a parked child run', () => {
  it.effect(
    'delivers a follow-up its rows still queue exactly once, with the message it becomes (C3)',
    () =>
      Effect.gen(function* () {
        const session = yield* quietSession();
        const parentRunId = generateRunId();
        const runId = startedRun(session, parentRunId);
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
          aggregateId: rowAggregate(runId),
          followUpId: 'follow-up-1',
          content: { text: asked, from: { kind: 'user' as const } },
        };
        publishTestRows(session, [queued]);
        yield* session.log.settled;

        const resumed = yield* forkLoop({
          runId,
          session,
          parentRunId,
          resume: true,
          script: [textTurn('second cycle'), textTurn('never reached')],
        });
        yield* resumed.park(1);
        const resumedState = yield* session.runHistory.load(runId);
        expect(userTexts(resumedState)).toContain(asked);
        expect((yield* session.followUps.read(runId)).followUps).toEqual([]);
        yield* Fiber.interrupt(resumed.fiber);

        // A producer that replays the delivery after a restart writes the
        // same id again; it names a follow-up already consumed.
        publishTestRows(session, [queued]);
        yield* session.log.settled;
        const again = yield* forkLoop({
          runId,
          session,
          parentRunId,
          resume: true,
          script: [textTurn('never reached')],
        });
        yield* again.park(0);
        expect(again.requests).toHaveLength(0);
        expect(
          userTexts(yield* session.runHistory.load(runId)).filter(
            (text) => text === asked,
          ),
        ).toEqual([asked]);
        yield* Fiber.interrupt(again.fiber);
      }),
  );
});

describe('a parked root run', () => {
  it.effect('answers a follow-up consumed just before the loop exited', () =>
    Effect.gen(function* () {
      const session = yield* quietSession();
      const runId = startedRun(session);
      const first = yield* forkLoop({
        runId,
        session,
        script: [textTurn('first')],
      });
      yield* first.park(0);
      yield* Fiber.interrupt(first.fiber);

      // The rows `FollowUps.consume` commits, and then nothing: the process
      // ended before the turn that answers them began.
      const parked = yield* session.runHistory.load(runId).pipe(Effect.orDie);
      if (parked === null) throw new Error('The run has no run history.');
      const cell = yield* session.runHistory.open(runId);
      yield* cell.append([
        appendRow(runId, [
          { role: 'user', content: [{ kind: 'text', text: 'answer me' }] },
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

      expect(resumed.requests).toHaveLength(1);
    }),
  );
});

describe('the batch a parked run consumes', () => {
  it.effect(
    'records what was asked and keeps the batch unconsumed when it cannot be applied',
    () =>
      Effect.gen(function* () {
        // A failed follow-up append (corrupt or oversized media, a provider
        // validation error) must still leave a record of what the user asked
        // for, and must not acknowledge input that never reached the model.
        const session = yield* quietSession();
        const runId = startedRun(session);
        const logger = new TraceEmitter();
        const info = vi.spyOn(logger, 'info');
        yield* session.log.settled;
        yield* session.followUps.send(runId, {
          text: 'use this diagram',
          mediaFiles: ['/tmp/texra-unreadable-figure.png'],
          from: { kind: 'user' as const },
        });

        const exit = yield* Effect.exit(
          runLoop({
            runId,
            session,
            logger,
            bound: { supportsVision: true },
            script: [textTurn('first')],
          }),
        );

        expect(exit._tag).toBe('Failure');
        expect(info).toHaveBeenCalledWith(
          'use this diagram',
          expect.objectContaining({ messageType: expect.any(String) }),
        );
        expect(
          (yield* session.followUps.read(runId)).followUps.map(
            (f) => f.content.text,
          ),
        ).toEqual(['use this diagram']);
      }),
  );
});
