import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { randomUUID } from 'node:crypto';
import { it } from '@effect/vitest';
import { Effect, Exit, Fiber, Layer, SynchronizedRef } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import type {
  FollowUpQueueBatchItem,
  FollowUpQueueInput,
} from '@agent/followUp/FollowUpQueue';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import { followUpsLayer } from '@agent/runtime/FollowUps';
import {
  ModelInvoker,
  turnText,
  type InvokeRequest,
} from '@agent/runtime/ModelInvoker';
import {
  appendRow,
  rowAggregate,
  runtimeSnapshotRow,
  snapshotRow,
  stepRow,
} from '@agent/runtime/loop/rows';
import {
  runToolUse,
  type ToolUseFlowContext,
} from '@agent/runtime/loop/toolUse';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import { AgentRun, type AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import { dispatchFactsFor } from '@agent/runtime/run/tools';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import { TraceEmitter } from '@agent/trace';
import type { Model, TurnResult } from '@llm/turn';
import { workspaceRoots } from '@platform/workspaceRoots';
import {
  AgentCategory,
  AgentRunStateSnapshotSchema,
  MESSAGE_TYPES,
  RUN_OUTCOME,
  RUN_PHASE,
  type RetryErrorInfo,
  type RunId,
} from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { hostStores } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { releaseRunResources } from '@tools/approval';
import { clearGoal, goalOf, startGoal } from '@tools/goal';
import { generateRunId, generateShortId } from '@utils/core';
import { TaskRunFileService } from '@utils/files/taskRunStorage';

import {
  eventsOfType,
  recordSessionEvents,
  seedTerminalRun,
  sessionWithInteractions,
} from '../progressTestUtils';

// ---------------------------------------------------------------------------
// The loop harness: the run's own services over a real session ledger and the
// session's real follow-up queue, with the model faked at the `ModelInvoker`
// seam. The wait, the drain and the consumption are the production ones, so
// what a parked run does with input is exercised end to end.
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

function testBoundModel(supportsVision: boolean): BoundModel {
  return {
    modelId: 'test-model',
    config: buildTestModelConfig({ capabilities: { supportsVision } }),
    compatibilityKey: 'DeepSeek',
    model: unusedModel,
    origin: ORIGIN,
    usageRoute: 'api-key',
    contextWindow: 200_000,
    supportsVision,
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

function textTurn(text: string): TurnResult {
  return {
    kind: 'http',
    providerResponseId: randomUUID(),
    requestedOrigin: ORIGIN,
    returnedModel: null,
    modelFingerprint: null,
    content: [{ kind: 'message', content: [{ kind: 'text', text }] }],
    finishReason: 'stop',
    usage: null,
  };
}

/** What the faked invoker reports for one turn, in script order. */
type ScriptedTurn = TurnResult | { readonly failWith: RetryErrorInfo };

function invokerLayer(script: readonly ScriptedTurn[], seen: InvokeRequest[]) {
  return Layer.effect(
    ModelInvoker,
    Effect.gen(function* () {
      const run = yield* AgentRun;
      const ledger = yield* RunLedger;
      const aggregateId = rowAggregate(run.runId);
      return {
        invoke: (state: RunState, request: InvokeRequest) =>
          Effect.gen(function* () {
            const scripted = script[seen.length];
            seen.push(request);
            if (scripted === undefined) {
              return yield* Effect.die(
                new Error('The scenario ran out of model turns.'),
              );
            }
            if ('failWith' in scripted) {
              // The runtime snapshot the invoker writes on a failed attempt:
              // the error a resumed run reads back off the fold.
              const failed = yield* ledger.appendBatch(run.runId, state, [
                runtimeSnapshotRow(run.runId, state, {
                  lastError: scripted.failWith,
                  pendingRetry: null,
                  declinedRoutes: [],
                }),
              ]);
              return {
                kind: 'failed' as const,
                state: failed,
                error: scripted.failWith,
              };
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
                  turn: scripted,
                  calls: dispatchFactsFor(
                    scripted,
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
              turn: scripted,
              text: turnText(scripted),
              usage: null,
              responseTimeMs: 1,
            };
          }),
      };
    }),
  );
}

interface LoopInit {
  readonly runId: RunId;
  readonly session: SessionHandle;
  readonly script: readonly ScriptedTurn[];
  /** A child run: its parent owns continuation across its turns. */
  readonly parentRunId?: RunId | null;
  readonly resume?: boolean;
  readonly drainedFollowUps?: readonly FollowUpQueueBatchItem[];
  readonly logger?: TraceEmitter;
  readonly supportsVision?: boolean;
  readonly stopAfterCycle?: boolean;
  /** The terminal structured-output tool, when the run has one. */
  readonly finalToolName?: string;
  readonly onIdle?: () => void;
  readonly onFollowUpConsumed?: () => void;
  /** Host wiring that is live while the loop can accept an interrupt. */
  readonly attachment?: {
    attach(context: ToolUseFlowContext): void;
    detach(context: ToolUseFlowContext): void;
  };
}

function agentRunTestLayer(init: LoopInit) {
  return Layer.effect(
    AgentRun,
    Effect.gen(function* () {
      const model = yield* SynchronizedRef.make(
        testBoundModel(init.supportsVision === true),
      );
      const logger = init.logger ?? new TraceEmitter();
      const scope = yield* Effect.scope;
      const runScope = createRunScope({
        runId: init.runId,
        session: init.session,
        signal: new AbortController().signal,
      });
      return {
        runId: init.runId,
        parentRunId: init.parentRunId ?? null,
        session: init.session,
        config: AgentConfigSchema.parse({
          agent: 'chat',
          model: 'test-model',
          agentCategory: AgentCategory.ToolUse,
        }),
        setting: AgentSettingSchema.parse({
          agentCategory: AgentCategory.ToolUse,
        }),
        prompt: AgentPromptSchema.parse({ userRequest: 'Do the thing.' }),
        logger,
        parentStage: logger.openStage('Run: chat'),
        // The launch stores a real run carries; no fixture reads through them.
        stores: hostStores(),
        toolPolicy: { stopAfterCycle: init.stopAfterCycle === true },
        userVarChannels: {},
        initialUserMessageForTranscript: 'Do the thing.',
        fileService: new TaskRunFileService(init.runId),
        tools: new MapToolRegistry({}),
        finalToolName: init.finalToolName ?? null,
        structured: { value: undefined },
        model,
        scope,
        declinedRoutes: [],
        pendingModelSwitch: { value: null },
        inScope: <A>(operation: () => A): A =>
          withRunContext(createRunContext({ runScope }), operation),
        usageMonitor: new UsageMonitor(
          {
            logger,
            runId: init.runId,
            runStageId: undefined,
            config: workspaceRoots().config,
          },
          { agentName: 'chat', agentCategory: AgentCategory.ToolUse },
        ),
        callbacks: {
          onModelChanged: vi.fn(),
          ...(init.onIdle ? { onIdle: init.onIdle } : {}),
          ...(init.onFollowUpConsumed
            ? { onFollowUpConsumed: init.onFollowUpConsumed }
            : {}),
        },
        interrupt: vi.fn(),
      } satisfies AgentRunShape;
    }),
  );
}

function loopProgram(init: LoopInit, requests: InvokeRequest[]) {
  return runToolUse({
    resume: init.resume === true,
    ...(init.drainedFollowUps
      ? { drainedFollowUps: init.drainedFollowUps }
      : {}),
    ...(init.attachment ? { attachment: init.attachment } : {}),
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        invokerLayer(init.script, requests),
        followUpsLayer,
        nativeToolTestLayer(),
      ).pipe(
        Layer.provideMerge(agentRunTestLayer(init)),
        Layer.provideMerge(Layer.succeed(RunLedger)(init.session.ledger)),
      ),
    ),
  );
}

/** Run one scripted run to its own exit. */
const runLoop = Effect.fn('test.runLoop')(function* (init: LoopInit) {
  const requests: InvokeRequest[] = [];
  const result = yield* loopProgram(init, requests);
  const state = yield* init.session.ledger.load(init.runId).pipe(Effect.orDie);
  return { result, requests, state };
});

/**
 * Drive the loop until its scripted turns are spent: the scenario's script is
 * the run's whole life, and the loop stops where the script ends rather than
 * being torn down mid-turn.
 */
const runUntilSpent = Effect.fn('test.runUntilSpent')(function* (
  init: LoopInit,
) {
  const requests: InvokeRequest[] = [];
  const exit = yield* Effect.exit(loopProgram(init, requests));
  const state = yield* init.session.ledger.load(init.runId).pipe(Effect.orDie);
  return { exit, requests, state };
});

/** Start a run that parks, for scenarios that drive it while it waits. */
const forkLoop = Effect.fn('test.forkLoop')(function* (init: LoopInit) {
  const requests: InvokeRequest[] = [];
  const fiber = yield* Effect.forkDetach(loopProgram(init, requests));
  return { fiber, requests };
});

/** Poll a real-time condition the parked loop settles on its own fiber. */
const waitFor = (condition: () => boolean, label: string) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`Timed out waiting for ${label}.`);
  });

/**
 * A session over the process roots: a goal is its run's own row, so a goal
 * scenario and the loop must share the session that carries it.
 */
function goalSession(overrides: Record<string, unknown> = {}): SessionHandle {
  const session = createProcessSession();
  session.interactions.use({ emit: () => {}, ...overrides });
  return session;
}

function quietSession(overrides: Record<string, unknown> = {}): SessionHandle {
  return sessionWithInteractions({ emit: () => {}, ...overrides });
}

function startedRun(session: SessionHandle): RunId {
  const runId = generateRunId();
  publishTestRunStart(session, runId);
  return runId;
}

/**
 * A run whose rows stop where a crash between a committed text response and
 * its post-response policy would leave them: the response and its step are
 * in the ledger, nothing after them is.
 */
const seedCommittedResponse = Effect.fn('test.seedCommittedResponse')(
  function* (session: SessionHandle, runId: RunId, text: string) {
    const ledger = session.ledger;
    const aggregate = rowAggregate(runId);
    const fresh: RunState = {
      commit: 0,
      snapshotCommit: null,
      rowsBeforeSnapshot: 0,
      family: 'toolUse',
      step: null,
      outcome: null,
      phase: null,
      round: 0,
      turn: 0,
      continuationIndex: 0,
      modelId: 'test-model',
      modelCompatibilityKey: 'DeepSeek',
      lastError: null,
      pendingRetry: null,
      declinedRoutes: [],
      messages: [],
      continuation: null,
      openAttempt: null,
      lastTurn: null,
      pendingResponse: null,
      pendingIntents: {},
      requests: {},
      usage: AgentRunStateSnapshotSchema.parse({}).usageAccumulator.totals,
      flow: null,
    };
    const opened = yield* ledger.appendBatch(runId, null, [
      appendRow(runId, [
        { role: 'user', content: [{ kind: 'text', text: 'Do the thing.' }] },
      ]),
      snapshotRow(runId, fresh, {
        phase: 'model.ready',
        turn: 1,
        state: { shouldSkipCycle: false, stateSlices: null },
      }),
    ]);
    const invocation = { invocationId: randomUUID(), attempt: 1 };
    return yield* ledger.appendBatch(runId, opened, [
      {
        type: 'model.message',
        aggregateId: aggregate,
        payload: {
          kind: 'attempt',
          invocation,
          origin: ORIGIN,
          delivery: 'stream',
        },
      },
      {
        type: 'model.message',
        aggregateId: aggregate,
        payload: {
          kind: 'response',
          responseId: randomUUID(),
          invocation,
          turn: textTurn(text),
          calls: [],
          usage: null,
        },
      },
      stepRow(runId, opened, 'response.ready'),
    ]);
  },
);

/** Put input on the run's queue before the loop claims it. */
function enqueue(
  session: SessionHandle,
  runId: RunId,
  items: readonly FollowUpQueueInput[],
): void {
  for (const item of items)
    session.followUps.submit(runId, item, 'recoverable');
}

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
  it.effect.each([false, true])(
    'suspends at WAITING once per invocation (input queued: %s)',
    (queued) =>
      Effect.gen(function* () {
        // A child's continuation belongs to the run that launched it: one
        // cycle per invocation, whether or not something is already queued.
        const session = quietSession();
        const runId = startedRun(session);
        if (queued) {
          enqueue(session, runId, [{ text: 'later', origin: 'user' }]);
        }

        const { result, requests } = yield* runLoop({
          runId,
          session,
          parentRunId: generateRunId(),
          script: [textTurn('one cycle')],
        });

        expect(result.outcome).toBe(RUN_PHASE.WAITING);
        expect(requests).toHaveLength(1);
      }),
  );

  it.effect(
    'consumes the batch its parent drained without reading the session queue',
    () =>
      Effect.gen(function* () {
        const session = quietSession();
        const runId = startedRun(session);
        const parentRunId = generateRunId();
        const onFollowUpConsumed = vi.fn();

        yield* runLoop({
          runId,
          session,
          parentRunId,
          script: [textTurn('first cycle')],
        });
        // Input the child loop did not hand over stays on the queue.
        enqueue(session, runId, [{ text: 'from the queue', origin: 'user' }]);

        const { result, state } = yield* runLoop({
          runId,
          session,
          parentRunId,
          resume: true,
          drainedFollowUps: [
            { text: 'state where finiteness is used', origin: 'user' },
          ],
          onFollowUpConsumed,
          script: [textTurn('second cycle')],
        });

        expect(result.outcome).toBe(RUN_PHASE.WAITING);
        expect(userTexts(state)).toContain('state where finiteness is used');
        expect(userTexts(state)).not.toContain('from the queue');
        expect(onFollowUpConsumed).toHaveBeenCalledOnce();
      }),
  );

  it.effect('stops after an error when no batch was drained', () =>
    Effect.gen(function* () {
      // A subagent that waited here would wait for a follow-up its
      // orchestrator was never told to send.
      const session = quietSession();
      const { result } = yield* runLoop({
        runId: startedRun(session),
        session,
        parentRunId: generateRunId(),
        script: [{ failWith: { message: 'boom', userRetryable: false } }],
      });

      expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
    }),
  );
});

describe('a parked root run', () => {
  it.effect(
    'reports idle at the turn boundary, before it waits for input',
    () =>
      Effect.gen(function* () {
        const session = quietSession();
        const runId = startedRun(session);
        const onIdle = vi.fn();
        enqueue(session, runId, [{ text: 'keep going', origin: 'user' }]);

        const { fiber, requests } = yield* forkLoop({
          runId,
          session,
          onIdle,
          script: [textTurn('first'), textTurn('second')],
        });
        yield* waitFor(
          () =>
            requests.length >= 2 &&
            session.runView(runId)?.status === RUN_PHASE.WAITING,
          'the second turn and the park after it',
        );
        yield* Fiber.interrupt(fiber);

        // Idle is a notification, not a suspension: the queued input still
        // reached the model in the same invocation.
        expect(onIdle).toHaveBeenCalled();
      }),
  );

  it.effect(
    'stops instead of waiting when the launch asked for one cycle',
    () =>
      Effect.gen(function* () {
        const session = quietSession();
        const { result, requests } = yield* runLoop({
          runId: startedRun(session),
          session,
          stopAfterCycle: true,
          script: [textTurn('done')],
        });

        expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
        expect(requests).toHaveLength(1);
      }),
  );

  it.effect('stops a one-cycle child instead of parking it as waiting', () =>
    Effect.gen(function* () {
      const session = quietSession();
      const { result, requests } = yield* runLoop({
        runId: startedRun(session),
        session,
        parentRunId: generateRunId(),
        stopAfterCycle: true,
        script: [textTurn('done')],
      });

      // A single-cycle native subagent's caller reads a WAITING result as
      // an invariant failure, so the cycle that finished must say so.
      expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect(
    'replays a recovered text response through the final-turn policy',
    () =>
      Effect.gen(function* () {
        const session = quietSession();
        const runId = startedRun(session);
        yield* seedCommittedResponse(session, runId, 'the prose answer');

        const { result, requests, state } = yield* runLoop({
          runId,
          session,
          resume: true,
          // One cycle, so the scenario ends at the turn it is about.
          stopAfterCycle: true,
          finalToolName: 'submit_output',
          script: [textTurn('and the structured one')],
        });

        // The crash landed between the response row and the live policy that
        // reads it. Treating the row as an already-finished turn would end
        // the run with no structured output attempted at all.
        expect(requests).toHaveLength(1);
        expect(requests[0]?.toolChoice).toEqual({ name: 'submit_output' });
        expect(userTexts(state)).toContain(
          'Submit the final structured output now.',
        );
        expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      }),
  );

  it.effect('waits while parked and runs again once input arrives', () =>
    Effect.gen(function* () {
      const session = quietSession();
      const runId = startedRun(session);
      const recorded = recordSessionEvents(session);

      const { fiber, requests } = yield* forkLoop({
        runId,
        session,
        script: [textTurn('first'), textTurn('second')],
      });
      yield* waitFor(
        () => session.runView(runId)?.status === RUN_PHASE.WAITING,
        'the parked run',
      );
      enqueue(session, runId, [{ text: 'carry on', origin: 'user' }]);
      yield* waitFor(
        () =>
          requests.length >= 2 &&
          session.runView(runId)?.status === RUN_PHASE.WAITING,
        'the second turn and the park after it',
      );
      yield* Fiber.interrupt(fiber);

      // The phase is the loop's own step on the session's plane, the single
      // rail: the park, then the step that leaves it.
      const steps = eventsOfType(
        yield* Effect.promise(() => recorded.read()),
        'flow.step',
      ).map((event) => event.payload.step);
      const parked = steps.indexOf('waiting');
      expect(parked).toBeGreaterThanOrEqual(0);
      expect(steps.slice(parked + 1).some((step) => step !== 'waiting')).toBe(
        true,
      );
    }),
  );

  it.effect('parks a run a retry cancelled, rather than leaving it there', () =>
    Effect.gen(function* () {
      const session = quietSession();
      const runId = startedRun(session);
      yield* Effect.promise(() =>
        seedTerminalRun(session, runId, RUN_OUTCOME.CANCELLED),
      );
      const recorded = recordSessionEvents(session);

      const { fiber } = yield* forkLoop({
        runId,
        session,
        script: [textTurn('first')],
      });
      yield* waitFor(
        () => session.runView(runId)?.status === RUN_PHASE.WAITING,
        'the parked run',
      );
      yield* Fiber.interrupt(fiber);

      // The loop's steps carry the run out of its cancelled terminal: it runs
      // before it parks.
      const steps = eventsOfType(
        yield* Effect.promise(() => recorded.read()),
        'flow.step',
      ).map((event) => event.payload.step);
      const parked = steps.indexOf('waiting');
      expect(parked).toBeGreaterThan(0);
      expect(steps.slice(0, parked).every((step) => step !== 'waiting')).toBe(
        true,
      );
    }),
  );
});

describe('the batch a parked run consumes', () => {
  it.effect(
    'enters the conversation as one user turn carrying every queued item',
    () =>
      Effect.gen(function* () {
        const session = quietSession();
        const runId = startedRun(session);
        const logger = new TraceEmitter();
        const info = vi.spyOn(logger, 'info');
        enqueue(session, runId, [
          {
            text: '<subagent-result>done</subagent-result>',
            origin: 'subagent_result',
          },
          { text: 'please revise the theorem', origin: 'user' },
        ]);

        const { fiber, requests } = yield* forkLoop({
          runId,
          session,
          logger,
          script: [textTurn('first'), textTurn('second')],
        });
        yield* waitFor(
          () =>
            requests.length >= 2 &&
            session.runView(runId)?.status === RUN_PHASE.WAITING,
          'the second turn and the park after it',
        );
        yield* Fiber.interrupt(fiber);
        const state = yield* session.ledger.load(runId).pipe(Effect.orDie);

        // One batch is one user message whose parts are the items in order;
        // the transcript still shows each of them as its own row.
        const batchMessage = state?.messages.filter(
          (message) => message.role === 'user',
        );
        expect(
          batchMessage
            ?.at(-1)
            ?.content.flatMap((part) =>
              part.kind === 'text' ? [part.text] : [],
            ),
        ).toEqual([
          '<subagent-result>done</subagent-result>',
          'please revise the theorem',
        ]);
        expect(info).toHaveBeenCalledWith('✓ subagent completed', {
          messageType: MESSAGE_TYPES.USER_MESSAGE,
        });
        expect(info).toHaveBeenCalledWith('please revise the theorem', {
          messageType: MESSAGE_TYPES.USER_MESSAGE,
        });
      }),
  );

  it.effect('logs a workflow delivery with its typed summary', () =>
    Effect.gen(function* () {
      // The delivery envelope carries the summary typed at the write site;
      // the transcript row producer parses it once and attaches it
      // structured, so renderers never re-extract it from the row text.
      const summary = {
        name: 'proofread-pipeline',
        outcome: 'completed',
        phaseCount: 1,
        taskDone: 2,
        taskTotal: 2,
        costUsd: 0.19,
        durationMs: 5_000,
        files: [{ path: 'paper.tex', added: 12, removed: 8 }],
        scriptPath: '.texra/workflow-scripts/proofread-pipeline.mjs',
        errorCause: null,
      };
      const escaped = JSON.stringify(summary).replaceAll('"', '&quot;');
      const session = quietSession();
      const runId = startedRun(session);
      const logger = new TraceEmitter();
      const info = vi.spyOn(logger, 'info');
      enqueue(session, runId, [
        {
          text: [
            '<workflow-script-result id="abc">',
            '<response>raw run log</response>',
            `<workflow-summary>${escaped}</workflow-summary>`,
            '</workflow-script-result>',
          ].join('\n'),
          origin: 'subagent_result',
        },
      ]);

      const { fiber, requests } = yield* forkLoop({
        runId,
        session,
        logger,
        script: [textTurn('first'), textTurn('second')],
      });
      yield* waitFor(
        () =>
          requests.length >= 2 &&
          session.runView(runId)?.status === RUN_PHASE.WAITING,
        'the second turn and the park after it',
      );
      yield* Fiber.interrupt(fiber);

      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('✓ proofread-pipeline completed'),
        expect.objectContaining({ data: { workflowSummary: summary } }),
      );
    }),
  );

  it.effect(
    'warns and drops media the model cannot read, attaching nothing',
    () =>
      Effect.gen(function* () {
        const session = quietSession();
        const runId = startedRun(session);
        const logger = new TraceEmitter();
        const info = vi.spyOn(logger, 'info');
        const warn = vi.spyOn(logger, 'warn');
        enqueue(session, runId, [
          {
            text: 'please inspect this figure',
            mediaFiles: ['/tmp/texra-figure.png'],
            origin: 'user',
          },
        ]);

        const { fiber, requests } = yield* forkLoop({
          runId,
          session,
          logger,
          supportsVision: false,
          script: [textTurn('first'), textTurn('second')],
        });
        yield* waitFor(
          () =>
            requests.length >= 2 &&
            session.runView(runId)?.status === RUN_PHASE.WAITING,
          'the second turn and the park after it',
        );
        yield* Fiber.interrupt(fiber);

        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('has no vision support'),
        );
        expect(info).toHaveBeenCalledWith(
          'please inspect this figure',
          expect.not.objectContaining({
            data: expect.objectContaining({ attachments: expect.anything() }),
          }),
        );
      }),
  );

  it.effect(
    'records what was asked and keeps the batch unconsumed when it cannot be applied',
    () =>
      Effect.gen(function* () {
        // A failed follow-up append (corrupt or oversized media, a provider
        // validation error) must still leave a record of what the user asked
        // for, and must not acknowledge input that never reached the model.
        const session = quietSession();
        const runId = startedRun(session);
        const logger = new TraceEmitter();
        const info = vi.spyOn(logger, 'info');
        const onFollowUpConsumed = vi.fn();
        enqueue(session, runId, [
          {
            text: 'use this diagram',
            mediaFiles: ['/tmp/texra-unreadable-figure.png'],
            origin: 'user',
          },
        ]);

        const exit = yield* Effect.exit(
          runLoop({
            runId,
            session,
            logger,
            supportsVision: true,
            onFollowUpConsumed,
            script: [textTurn('first')],
          }),
        );

        expect(exit._tag).toBe('Failure');
        expect(info).toHaveBeenCalledWith(
          'use this diagram',
          expect.objectContaining({ messageType: expect.any(String) }),
        );
        expect(onFollowUpConsumed).not.toHaveBeenCalled();
      }),
  );
});

describe('an active goal at the wait', () => {
  it.effect('continues the run with a synthetic turn instead of blocking', () =>
    Effect.gen(function* () {
      const session = goalSession();
      const runId = startedRun(session);
      const logger = new TraceEmitter();
      const info = vi.spyOn(logger, 'info');
      const onFollowUpConsumed = vi.fn();
      yield* startGoal(session, runId, 'Finish the autonomous proof audit.');

      try {
        const { requests, state } = yield* runUntilSpent({
          runId,
          session,
          logger,
          onFollowUpConsumed,
          script: [textTurn('first'), textTurn('second')],
        });

        expect(
          userTexts(state).some((text) =>
            text.includes('Finish the autonomous proof audit.'),
          ),
        ).toBe(true);
        // The run ran again instead of blocking for input, and a synthetic
        // turn is not the user's: it is neither logged nor acknowledged as
        // consumed input.
        expect(requests.length).toBeGreaterThan(1);
        expect(onFollowUpConsumed).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalledWith(
          expect.stringContaining('<goal_context>'),
          expect.anything(),
        );
      } finally {
        yield* clearGoal(session, runId);
      }
    }),
  );

  it.effect('lets queued user input win over the continuation', () =>
    Effect.gen(function* () {
      const session = goalSession();
      const runId = startedRun(session);
      yield* startGoal(session, runId, 'Keep going autonomously.');
      enqueue(session, runId, [{ text: 'user correction', origin: 'user' }]);

      try {
        const { state } = yield* runUntilSpent({
          runId,
          session,
          script: [textTurn('first'), textTurn('second')],
        });

        // The first thing the parked run consumed is the user's, not the
        // goal's; the continuation only speaks for a queue with nothing in it.
        expect(userTexts(state).at(1)).toBe('user correction');
      } finally {
        yield* clearGoal(session, runId);
      }
    }),
  );

  it.effect(
    'is paused, with its approval bypasses cleared, after a failure',
    () =>
      Effect.gen(function* () {
        const setApprovalBypassState = vi.fn();
        const session = goalSession({ setApprovalBypassState });
        const runId = startedRun(session);
        yield* startGoal(session, runId, 'finish the refactor');

        try {
          const { result } = yield* runLoop({
            runId,
            session,
            stopAfterCycle: true,
            script: [
              { failWith: { message: 'cycle failed', userRetryable: false } },
            ],
          });

          expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
          expect(goalOf(session, runId)?.status).toBe('paused');
          for (const kind of ['bash', 'toolEdit', 'superYolo']) {
            expect(setApprovalBypassState).toHaveBeenCalledWith({
              runId,
              kind,
              bypassActive: false,
            });
          }
        } finally {
          yield* clearGoal(session, runId);
          releaseRunResources(runId);
        }
      }),
  );

  it.effect(
    'is recovered, not paused, by a batch the parent already drained',
    () =>
      Effect.gen(function* () {
        // Regression #9443: input the child-run loop already took off the queue
        // reaches the model, so the error clears without pausing the goal or
        // dropping its unattended approvals first.
        const setApprovalBypassState = vi.fn();
        const session = goalSession({ setApprovalBypassState });
        const runId = startedRun(session);
        const parentRunId = generateRunId();
        yield* startGoal(session, runId, 'finish the autonomous proof');

        try {
          yield* runLoop({
            runId,
            session,
            parentRunId,
            script: [
              {
                failWith: {
                  message: 'stale failure from the previous cycle',
                  userRetryable: false,
                },
              },
            ],
          });
          setApprovalBypassState.mockClear();

          const { result, state } = yield* runLoop({
            runId,
            session,
            parentRunId,
            resume: true,
            drainedFollowUps: [{ text: 'try the other lemma', origin: 'user' }],
            script: [textTurn('recovered')],
          });

          expect(result.outcome).toBe(RUN_PHASE.WAITING);
          expect(userTexts(state)).toContain('try the other lemma');
          expect(goalOf(session, runId)?.status).toBe('active');
          expect(setApprovalBypassState).not.toHaveBeenCalled();
        } finally {
          yield* clearGoal(session, runId);
          releaseRunResources(runId);
        }
      }),
  );
});

describe('the host wiring a run attaches', () => {
  // The loop registers the flow context on the run handle and may interrupt
  // it in the same call. A throw anywhere after that first statement used to
  // strand the live context on the handle, because the pairing lived in the
  // value the callback never got to return.
  it.effect('detaches a host whose attach threw after wiring itself up', () =>
    Effect.gen(function* () {
      const session = quietSession();
      const runId = startedRun(session);
      const attachFailure = new Error('host wiring failed');
      const detached: ToolUseFlowContext[] = [];

      const exit = yield* Effect.exit(
        loopProgram(
          {
            runId,
            session,
            script: [textTurn('never reached')],
            attachment: {
              attach: () => {
                throw attachFailure;
              },
              detach: (context) => {
                detached.push(context);
              },
            },
          },
          [],
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(detached).toHaveLength(1);
    }),
  );
});
