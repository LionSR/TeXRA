import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { randomUUID } from 'node:crypto';

import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber, Layer, SynchronizedRef } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { MapToolRegistry, type ITool } from '@agent/core/tools/ToolTypes';
import { followUpsLayer } from '@agent/runtime/FollowUps';
import type {
  HostUserQuestionRequest,
  UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';
import { ModelInvoker, turnText } from '@agent/runtime/ModelInvoker';
import { rowAggregate, stepRow } from '@agent/runtime/loop/rows';
import { runToolUse } from '@agent/runtime/loop/toolUse';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import { AgentRun, type AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import { dispatchFactsFor } from '@agent/runtime/run/tools';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import { TraceEmitter } from '@agent/trace';
import type { Model, TurnResult } from '@llm/turn';
import { AgentCategory, type RunId } from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { hostStores } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { generateRunId, generateShortId } from '@utils/core';
import { TaskRunFileService } from '@utils/files/taskRunStorage';

import { sessionWithInteractions } from '../progressTestUtils';

// ---------------------------------------------------------------------------
// The loop harness: the run's own services over a real session ledger, with
// the model faked at the `ModelInvoker` seam. The rows the fake writes are the
// production ones, so the fold, the resume rules and dispatch all run against
// the durable facts a live turn leaves behind.
// ---------------------------------------------------------------------------

const ORIGIN = {
  protocol: 'deepseek-chat',
  codecVersion: 1,
  requestedModel: 'test-model',
  deployment: {
    endpoint: 'https://api.example.test/v1',
    credentialScope: 'deepseek',
  },
} as const;

/**
 * A `Model` the harness never invokes: the invoker seam is faked above it.
 * Compaction still probes the optional token counter, and this model offers
 * none, so that one read answers `undefined` and the text heuristic decides.
 */
const unusedModel = new Proxy({} as Model, {
  get(_target, property) {
    if (property === 'estimateInputTokens') return undefined;
    throw new Error(`The harness model has no ${String(property)}.`);
  },
});

function testBoundModel(): BoundModel {
  return {
    modelId: 'test-model',
    config: buildTestModelConfig(),
    compatibilityKey: 'DeepSeek',
    model: unusedModel,
    origin: ORIGIN,
    usageProvider: 'openai',
    usageRoute: 'api-key',
    contextWindow: 200_000,
    supportsVision: false,
    supportsNativePdf: false,
    supportsNativeAudio: false,
    supportsReasoning: false,
    supportsForcedToolChoice: true,
    wireRouteKey: 'test-route',
    modelRetryRouteKey: 'test-route/test-model',
    routedOnKimiCode: false,
    backgroundCapable: false,
  };
}

function toolCallTurn(
  calls: readonly { readonly id: string; readonly name: string }[],
): TurnResult {
  return {
    kind: 'http',
    providerResponseId: `resp-${calls.map((call) => call.id).join('-')}`,
    requestedOrigin: ORIGIN,
    returnedModel: null,
    modelFingerprint: null,
    content: calls.map((call) => ({
      kind: 'local-call' as const,
      providerCallId: call.id,
      name: call.name,
      argumentsText: '{}',
    })),
    finishReason: 'tool-calls',
    usage: null,
  };
}

function textTurn(text: string): TurnResult {
  return {
    kind: 'http',
    providerResponseId: `resp-text-${text.length}`,
    requestedOrigin: ORIGIN,
    returnedModel: null,
    modelFingerprint: null,
    content: [{ kind: 'message', content: [{ kind: 'text', text }] }],
    finishReason: 'stop',
    usage: null,
  };
}

/** The turns a scenario hands the loop, in order. */
function invokerLayer(turns: readonly TurnResult[]) {
  return Layer.effect(
    ModelInvoker,
    Effect.gen(function* () {
      const run = yield* AgentRun;
      const ledger = yield* RunLedger;
      const aggregateId = rowAggregate(run.runId);
      let index = 0;
      return {
        invoke: (state: RunState) =>
          Effect.gen(function* () {
            const turn = turns[index];
            index += 1;
            if (turn === undefined) {
              return yield* Effect.die(
                new Error('The scenario ran out of model turns.'),
              );
            }
            const bound = yield* SynchronizedRef.get(run.model);
            const invocation = { invocationId: randomUUID(), attempt: 1 };
            const responseId = randomUUID();
            const next = yield* ledger.appendBatch(run.runId, state, [
              {
                type: 'model.message',
                aggregateId,
                payload: {
                  kind: 'attempt',
                  invocation,
                  origin: bound.origin,
                  delivery: 'stream',
                },
              },
              {
                type: 'model.message',
                aggregateId,
                payload: {
                  kind: 'response',
                  responseId,
                  invocation,
                  turn,
                  calls: dispatchFactsFor(
                    turn,
                    run.tools,
                    run.logger,
                    generateShortId,
                  ),
                  usage: null,
                },
              },
              stepRow(run.runId, state, 'response.ready'),
            ]);
            return {
              kind: 'response' as const,
              state: next,
              responseId,
              turn,
              text: turnText(turn),
              usage: null,
              responseTimeMs: 1,
            };
          }),
      };
    }),
  );
}

interface HarnessInit {
  readonly runId: RunId;
  readonly session: SessionHandle;
  readonly tools: Record<string, ITool>;
  readonly turns: readonly TurnResult[];
  /** Headless: the run stops after one turn instead of parking for input. */
  readonly stopAfterCycle?: boolean;
}

function agentRunTestLayer(init: HarnessInit) {
  return Layer.effect(
    AgentRun,
    Effect.gen(function* () {
      const model = yield* SynchronizedRef.make(testBoundModel());
      const scope = yield* Effect.scope;
      const logger = new TraceEmitter();
      const runScope = createRunScope({
        runId: init.runId,
        session: init.session,
        signal: new AbortController().signal,
      });
      return {
        runId: init.runId,
        parentRunId: null,
        session: init.session,
        config: AgentConfigSchema.parse({
          agent: 'chat',
          model: 'test-model',
          agentCategory: AgentCategory.ToolUse,
        }),
        setting: AgentSettingSchema.parse({
          agentCategory: AgentCategory.ToolUse,
          tools: Object.keys(init.tools).map((name) => ({ name })),
        }),
        prompt: AgentPromptSchema.parse({ userRequest: 'Run the tools.' }),
        logger,
        parentStage: logger.openStage('Run: chat'),
        // The launch stores a real run carries; no fixture reads through them.
        stores: hostStores(),
        toolPolicy: { stopAfterCycle: init.stopAfterCycle === true },
        userVarChannels: {},
        initialUserMessageForTranscript: 'Run the tools.',
        fileService: new TaskRunFileService(init.runId),
        tools: new MapToolRegistry(init.tools),
        finalToolName: null,
        structured: { value: undefined },
        model,
        scope,
        pendingModelSwitch: { value: null },
        inScope: <A>(operation: () => A): A =>
          withRunContext(createRunContext({ runScope }), operation),
        usageMonitor: new UsageMonitor(
          { logger, runId: init.runId, runStageId: undefined },
          { agentName: 'chat', agentCategory: AgentCategory.ToolUse },
        ),
        callbacks: { onModelChanged: vi.fn() },
        interrupt: vi.fn(),
      } satisfies AgentRunShape;
    }),
  );
}

function loopLayer(init: HarnessInit) {
  return Layer.mergeAll(invokerLayer(init.turns), followUpsLayer).pipe(
    Layer.provideMerge(agentRunTestLayer(init)),
    Layer.provideMerge(Layer.succeed(RunLedger)(init.session.ledger)),
  );
}

/** A barrier tool whose call never settles, so a stop catches it in flight. */
function blockingTool(name: string) {
  let started: () => void = () => {};
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const call = vi.fn(async () => {
    started();
    await new Promise(() => {});
    return { status: 'executed' as const, output: `${name} done` };
  });
  return {
    call,
    startedPromise,
    tool: { call, definition: { name } } as ITool,
  };
}

function executedTool(name: string) {
  const call = vi.fn(async () => ({
    status: 'executed' as const,
    output: `${name} done`,
  }));
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
 * ledger defends it by construction: a response that requested tools enters
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
        const asked: HostUserQuestionRequest[] = [];
        const session = sessionWithInteractions({
          emit: () => {},
          cancel: () => {},
          askUserQuestion: async (request: HostUserQuestionRequest) => {
            asked.push(request);
            // The person answers "Skip": the model is told the call was
            // skipped rather than being handed a blind second run.
            return {
              action: 'submit' as const,
              answers: { [request.questions[0].question]: 'Skip' },
            };
          },
        });
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
        yield* Effect.promise(() => toolB.startedPromise);
        yield* Fiber.interrupt(fiber);

        // call-a settled before the stop, call-b was in flight, call-c is a
        // later barrier that never started.
        expect(toolA.call).toHaveBeenCalledTimes(1);
        expect(toolB.call).toHaveBeenCalledTimes(1);
        expect(toolC.call).not.toHaveBeenCalled();

        const interrupted = yield* session.ledger
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
        expect(asked).toHaveLength(1);
        expect(asked[0].questions[0].question).toContain('toolB');
        expect(toolB.call).toHaveBeenCalledTimes(1);
        // The call that never started runs normally on resume.
        expect(toolC.call).toHaveBeenCalledTimes(1);

        const delivered = yield* session.ledger.load(runId).pipe(Effect.orDie);
        const group = delivered?.messages.find(
          (message) => message.role === 'tool',
        );
        // Every requested call is paired exactly once, in call order.
        expect(group?.role === 'tool' ? group.results.length : 0).toBe(3);
        expect(delivered?.pendingResponse).toBeNull();
      }),
  );

  /**
   * The barrier prompt is a question for a person, and only a person's answer
   * retires it. A host Stop settles the pending question as a cancellation
   * (`session.interactions.cancel` -> `{ action: 'reject', cause }`), which
   * decides nothing: no `approval.resolved` is written, the request stays
   * open under the intent's binding, and the next resume presents the same
   * request id rather than telling the model a person skipped the call.
   */
  it.effect(
    'records no decision when the outcome-unknown prompt is cancelled, and re-presents it on the next resume',
    () =>
      Effect.gen(function* () {
        const asked: HostUserQuestionRequest[] = [];
        let answer: (
          request: HostUserQuestionRequest,
        ) => UserQuestionSettlement = () => ({
          action: 'reject',
          cause: 'Run interrupted.',
        });
        const session = sessionWithInteractions({
          emit: () => {},
          cancel: () => {},
          askUserQuestion: async (request: HostUserQuestionRequest) => {
            asked.push(request);
            return answer(request);
          },
        });
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
        yield* Effect.promise(() => toolB.startedPromise);
        yield* Fiber.interrupt(fiber);

        // The first resume asks, and the prompt is cancelled under it.
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
        expect(asked).toHaveLength(1);

        const open = yield* session.ledger.load(runId).pipe(Effect.orDie);
        const request = open?.approvals[asked[0].requestId];
        // The request stands undecided, and the call is still outcome-unknown.
        expect(request?.resolved).toBe(false);
        expect(request?.decision).toBeNull();
        expect(Object.keys(open?.pendingResponse?.settled ?? {})).toEqual([
          'call-a',
        ]);
        expect(toolB.call).toHaveBeenCalledTimes(1);
        expect(toolC.call).not.toHaveBeenCalled();

        // The next resume presents the same request, and the answer decides.
        answer = (request) => ({
          action: 'submit',
          answers: { [request.questions[0].question]: 'Skip' },
        });
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
        expect(asked).toHaveLength(2);
        expect(asked[1].requestId).toBe(asked[0].requestId);

        const delivered = yield* session.ledger.load(runId).pipe(Effect.orDie);
        expect(delivered?.approvals[asked[0].requestId]?.decision).toBe(
          'skipped',
        );
        const group = delivered?.messages.find(
          (message) => message.role === 'tool',
        );
        expect(group?.role === 'tool' ? group.results.length : 0).toBe(3);
      }),
  );
});
