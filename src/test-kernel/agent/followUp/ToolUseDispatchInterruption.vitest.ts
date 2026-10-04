import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import type { ITool } from '@agent/core/tools/ToolTypes';
import { runToolUse } from '@agent/runtime/loop/toolUse';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { finalizeRun } from '@agent/storage/runLifecycle';
import {
  RUN_OUTCOME,
  type RequestDecision,
  type ToolOutcomePermission,
} from '@shared/schemas';
import { RunHistory } from '@shared/session/runHistory';
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

import {
  autoDecideRequests,
  sessionWithInteractions,
} from '../progressTestUtils';

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

/**
 * The outcome-unknown barrier is a `request.opened` on the run and its answer
 * is the `request.decided` row a surface lands: record every question the
 * dispatch asks and answer it, or return null to leave it standing.
 */
function askedQuestions(
  session: SessionHandle,
  answer: (question: ToolOutcomePermission) => RequestDecision,
): { readonly questions: ToolOutcomePermission[] } {
  const questions: ToolOutcomePermission[] = [];
  autoDecideRequests(session, (opened) => {
    if (opened.payload.kind !== 'toolOutcome') return null;
    questions.push(opened.payload.data);
    return answer(opened.payload.data);
  });
  return { questions };
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
        // The person answers "Skip": the model is told the call was skipped
        // rather than being handed a blind second run.
        const asked = askedQuestions(session, () => ({ action: 'skip' }));

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
        expect(
          Object.keys(interrupted?.pendingResponse?.settled ?? {}),
        ).toEqual(['call-a']);

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

        // The outcome-unknown barrier asked before anything re-ran, and was
        // not re-run when the answer was "skip".
        expect(asked.questions).toHaveLength(1);
        expect(asked.questions[0].toolName).toBe('toolB');
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
        expect(delivered?.pendingResponse).toBeNull();
      }),
  );

  /**
   * A policy with nobody to ask (yolo, never, a headless host) denies the
   * barrier prompt, and would deny it again on every resume: the denial is a
   * skip, so the resumed run completes instead of interrupting itself into a
   * failure that no resume can get past.
   */
  it.effect('skips an outcome-unknown barrier the policy denies', () =>
    Effect.gen(function* () {
      const session = yield* sessionWithInteractions({ emit: () => {} });
      const runId = generateRunId();
      publishTestRunStart(session, runId);
      const asked = askedQuestions(session, () => ({
        action: 'deny',
        reason: 'No person can answer here.',
      }));
      const toolB = blockingTool('toolB');
      const tools = { toolB: toolB.tool };
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
      expect(asked.questions).toHaveLength(1);
      expect(toolB.call).toHaveBeenCalledTimes(1);
      const delivered = yield* session.runHistory
        .load(runId)
        .pipe(Effect.orDie);
      const group = delivered?.messages.find(
        (message) => message.role === 'tool',
      );
      expect(group?.role === 'tool' ? group.results[0]?.status : null).toBe(
        'error',
      );
    }),
  );

  /**
   * Parallel-safe is about concurrency, not about running twice: an
   * interrupted parallel-safe call whose tool is not replay-safe is asked
   * about like a barrier, never re-run blind.
   */
  it.effect(
    'asks before re-running a parallel-safe call that is not replay-safe',
    () =>
      Effect.gen(function* () {
        const session = yield* sessionWithInteractions({ emit: () => {} });
        const runId = generateRunId();
        publishTestRunStart(session, runId);
        const asked = askedQuestions(session, () => ({ action: 'skip' }));
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
        expect(asked.questions).toHaveLength(1);
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
      askedQuestions(session, () => ({ action: 'deny', reason: 'yolo' }));
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
      yield* session.settlePublications();
      yield* session.followUps.submit(
        runId,
        { text: 'What is 2+2?', from: { kind: 'user' } },
        'recoverable',
      );

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

  /**
   * The barrier prompt is a question for a person, and only a person's answer
   * retires it. An automatic close (a stop, a disposed session) lands
   * `{ action: 'cancel' }`, which decides nothing about the call: no
   * `tool.intent` is admitted and no skip is reported to the model. The
   * dispatch interrupts, and the next resume asks the barrier again under a
   * replacement request rather than telling the model a person skipped it.
   */
  it.effect(
    'records no call decision when the outcome-unknown prompt is cancelled, and asks again on the next resume',
    () =>
      Effect.gen(function* () {
        // The first ask is closed automatically, not answered by a person.
        let answer: (
          question: ToolOutcomePermission,
        ) => RequestDecision = () => ({
          action: 'cancel',
          cause: 'Run interrupted.',
        });
        const session = yield* sessionWithInteractions({ emit: () => {} });
        const runId = generateRunId();
        publishTestRunStart(session, runId);
        const asked = askedQuestions(session, (question) => answer(question));

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

        // The first resume asks, and the prompt is closed under it.
        const cancelled = yield* Effect.exit(
          runToolUse({ resume: true }).pipe(
            Effect.provide(
              loopLayer({
                runId,
                session,
                tools,
                turns: [],
                stopAfterCycle: true,
              }),
            ),
          ),
        );
        expect(
          Exit.isFailure(cancelled) && Cause.hasInterrupts(cancelled.cause),
        ).toBe(true);
        expect(asked.questions).toHaveLength(1);

        const open = yield* session.runHistory.load(runId).pipe(Effect.orDie);
        const request = open?.requests[asked.questions[0].requestId];
        // The close is on the request, and it decides nothing about the call:
        // no rerun was admitted and no skip was reported.
        expect(request?.decision).toMatchObject({ action: 'cancel' });
        expect(Object.keys(open?.pendingResponse?.settled ?? {})).toEqual([
          'call-a',
        ]);
        expect(toolB.call).toHaveBeenCalledTimes(1);
        expect(toolC.call).not.toHaveBeenCalled();

        // The next resume asks again, and the answer decides.
        answer = () => ({ action: 'skip' });
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
        expect(asked.questions).toHaveLength(2);
        // A request retired without a person's answer is replaced, never
        // reopened.
        expect(asked.questions[1].requestId).not.toBe(
          asked.questions[0].requestId,
        );

        const delivered = yield* session.runHistory
          .load(runId)
          .pipe(Effect.orDie);
        expect(
          delivered?.requests[asked.questions[1].requestId]?.decision,
        ).toMatchObject({ action: 'skip' });
        const group = delivered?.messages.find(
          (message) => message.role === 'tool',
        );
        expect(group?.role === 'tool' ? group.results.length : 0).toBe(3);
      }),
  );
});
