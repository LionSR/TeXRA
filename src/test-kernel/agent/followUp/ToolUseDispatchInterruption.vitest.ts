import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import type { ITool } from '@agent/core/tools/ToolTypes';
import { runToolUse } from '@agent/runtime/loop/toolUse';
import { finalizeRun } from '@agent/storage/runLifecycle';
import { RUN_OUTCOME } from '@shared/schemas';
import { RunHistory } from '@shared/session/runHistory';
import type { RunState } from '@shared/session/runStateFold';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  agentRunTestLayer,
  scriptedInvokerLayer,
  textTurn,
  toolCallTurn,
  type ScriptedRunInit,
} from '@test/support/scriptedRunLayers';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';

import { sessionWithInteractions } from '../progressTestUtils';

import type { TurnResult } from '@texra-ai/llm';

// ---------------------------------------------------------------------------
// The loop harness: the run's own services over a real session run history, with
// the model faked at the `ModelInvoker` seam. The rows the fake writes are the
// production ones, so the fold, the resume rules and dispatch all run against
// the durable facts a live turn leaves behind.
// ---------------------------------------------------------------------------

interface HarnessInit extends ScriptedRunInit {
  readonly tools: Record<string, ITool>;
  readonly turns: readonly TurnResult[];
}

/** The calls a folded state holds settled. */
const settledIds = (state: RunState | null | undefined): string[] =>
  Object.entries(state?.pendingResponse?.records ?? {}).flatMap(([id, call]) =>
    call.status.kind === 'settled' ? [id] : [],
  );

function loopLayer(init: HarnessInit) {
  return Layer.mergeAll(
    scriptedInvokerLayer(init.turns),
    nativeToolTestLayer(),
  ).pipe(
    Layer.provideMerge(agentRunTestLayer(init)),
    Layer.provideMerge(Layer.succeed(RunHistory)(init.session.runHistory)),
  );
}

/** A barrier tool whose call never settles, so a stop catches it in flight. */
function blockingTool(name: string) {
  const started = Deferred.makeUnsafe<void>();
  const call = vi.fn(() =>
    Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
  );

  return {
    call,
    started: Deferred.await(started),
    tool: { call, definition: { name } } as ITool,
  };
}

function executedTool(name: string) {
  const call = vi.fn(() =>
    Effect.succeed({
      status: 'executed' as const,
      output: `${name} done`,
    }),
  );
  return { call, tool: { call, definition: { name } } as ITool };
}

const CALLS = [
  { id: 'call-a', name: 'toolA' },
  { id: 'call-b', name: 'toolB' },
  { id: 'call-c', name: 'toolC' },
];

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
describe('tool dispatch interrupted mid-turn', () => {
  it.effect(
    'leaves no half-delivered tool turn in history, and resume pairs every call',
    () =>
      Effect.gen(function* () {
        const session = yield* sessionWithInteractions({ emit: () => {} });
        const runId = generateRunId();
        publishTestRunStart(session, runId);
        const toolA = executedTool('toolA');
        const toolB = blockingTool('toolB');
        const toolC = executedTool('toolC');
        const tools = {
          toolA: toolA.tool,
          toolB: toolB.tool,
          toolC: toolC.tool,
        };

        const fiber = yield* Effect.forkDetach(
          runToolUse({ resume: false }).pipe(
            Effect.provide(
              loopLayer({
                runId,
                session,
                tools,
                turns: [toolCallTurn(CALLS)],
                stopAfterCycle: true,
              }),
            ),
          ),
        );
        yield* toolB.started;
        yield* Fiber.interrupt(fiber);

        // call-a settled before the stop, call-b was in flight, call-c is a
        // later barrier that never started.
        expect(toolA.call).toHaveBeenCalledTimes(1);
        expect(toolB.call).toHaveBeenCalledTimes(1);
        expect(toolC.call).not.toHaveBeenCalled();

        const interrupted = yield* session.runHistory
          .load(runId)
          .pipe(Effect.orDie);
        // No assistant tool turn and no tool group: the paid response is
        // pending, with the one call that settled recorded against it.
        expect(interrupted?.messages.map((message) => message.role)).toEqual([
          'user',
        ]);
        expect(settledIds(interrupted)).toEqual(['call-a']);

        const resumed = yield* runToolUse({ resume: true }).pipe(
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

        const delivered = yield* session.runHistory
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
   * Parallel-safe is about concurrency, not about running twice: an
   * interrupted parallel-safe call whose tool is not replay-safe settles as
   * outcome unknown like a barrier, never re-run blind.
   */
  it.effect('never re-runs a parallel-safe call that is not replay-safe', () =>
    Effect.gen(function* () {
      const session = yield* sessionWithInteractions({ emit: () => {} });
      const runId = generateRunId();
      publishTestRunStart(session, runId);
      const toolB = blockingTool('toolB');
      const tools = { toolB: { ...toolB.tool, parallelSafe: true } };
      const calls = [{ id: 'call-b', name: 'toolB' }];
      const fiber = yield* Effect.forkDetach(
        runToolUse({ resume: false }).pipe(
          Effect.provide(
            loopLayer({
              runId,
              session,
              tools,
              turns: [toolCallTurn(calls)],
              stopAfterCycle: true,
            }),
          ),
        ),
      );
      yield* toolB.started;
      yield* Fiber.interrupt(fiber);

      const resumed = yield* runToolUse({ resume: true }).pipe(
        Effect.provide(
          loopLayer({
            runId,
            session,
            tools,
            turns: [textTurn('The call was skipped.')],
            stopAfterCycle: true,
          }),
        ),
      );
      expect(resumed.outcome).toBe('completed');
      expect(toolB.call).toHaveBeenCalledTimes(1);
    }),
  );

  /**
   * A user's follow-up to a stopped response joins that response's delivery:
   * the one request after the resume carries the skipped call's result and
   * then the follow-up, so the model reads the new instruction before it
   * decides whether to run anything again.
   */
  it.effect('delivers a follow-up to a stopped response with its results', () =>
    Effect.gen(function* () {
      const session = yield* sessionWithInteractions({ emit: () => {} });
      const runId = generateRunId();
      publishTestRunStart(session, runId);
      const toolB = blockingTool('toolB');
      const tools = { toolB: toolB.tool };
      const fiber = yield* Effect.forkDetach(
        runToolUse({ resume: false }).pipe(
          Effect.provide(
            loopLayer({
              runId,
              session,
              tools,
              turns: [toolCallTurn([{ id: 'call-b', name: 'toolB' }])],
              stopAfterCycle: true,
            }),
          ),
        ),
      );
      yield* toolB.started;
      yield* Fiber.interrupt(fiber);
      // The halt row the resume's join reads commits with the stopped run's
      // end, as its lifecycle writes it.
      yield* Fiber.await(fiber);
      yield* finalizeRun(session, { runId, outcome: RUN_OUTCOME.CANCELLED });
      yield* session.settled;
      yield* session.followUps.send(runId, {
        text: 'What is 2+2?',
        from: { kind: 'user' },
      });

      // One model turn: a second request would run out of scripted turns.
      const resumed = yield* runToolUse({ resume: true }).pipe(
        Effect.provide(
          loopLayer({
            runId,
            session,
            tools,
            turns: [textTurn('4')],
            stopAfterCycle: true,
          }),
        ),
      );
      expect(resumed.outcome).toBe('completed');
      expect(toolB.call).toHaveBeenCalledTimes(1);
      const state = yield* session.runHistory.load(runId).pipe(Effect.orDie);
      expect(state?.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'user',
        'assistant',
      ]);
      expect(state?.messages[3]).toMatchObject({
        content: [{ kind: 'text', text: 'What is 2+2?' }],
      });
    }),
  );
});
