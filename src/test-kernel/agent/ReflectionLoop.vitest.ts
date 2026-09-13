/**
 * The reflection family's loop-boundary suite: `runReflection` driven over a
 * real session ledger with the model faked at the `ModelInvoker` seam. It
 * pins what the durable rows must say at the boundary — the round loop's
 * compile repair, resume from the last snapshot, the output facts a round
 * publishes, the token-limited response, and the interrupt — replacing the
 * per-node suites the retired engine's internals used to pin.
 */
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { randomUUID } from 'node:crypto';
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, SynchronizedRef } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import {
  reflectionFlowState,
  rowAggregate,
  runtimeSnapshotRow,
  stepRow,
} from '@agent/runtime/loop/rows';
import { runReflection } from '@agent/runtime/loop/reflection';
import {
  ModelInvoker,
  turnText,
  type InvokeRequest,
} from '@agent/runtime/ModelInvoker';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import { AgentRun, type AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import { TraceEmitter } from '@agent/trace';
import type { Model, TurnResult } from '@llm/turn';
import {
  AgentCategory,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  type CompileResult,
  type OutputFileInfo,
  type RetryErrorInfo,
  type RunId,
} from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { StreamLog } from '@shared/session/traceEntries';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import {
  attachTestTranscriptFold,
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import {
  hostStores,
  installedHost,
  installPlatform,
  setupPlatform,
} from '@test/support/setupPlatform';
import { generateRunId, isObject } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { createRunStorageLocation } from '@utils/files/fileLocation';
import { TaskRunFileService } from '@utils/files/taskRunStorage';

import {
  createRecordingHost,
  recordTraceEvents,
  traceEventsOfType,
} from './progressTestUtils';

/**
 * The reflection loop over a real session ledger: the round loop, the
 * compile-rejection policy, continuation and resume are production code; the
 * model is faked at the `ModelInvoker` seam and the round's output pipeline at
 * its module seams, so a scenario scripts turns and compile verdicts and the
 * loop decides what to do with them.
 *
 * These cases carry the round-limit, compile-repair, output-fact,
 * continuation and interrupt coverage that the retired flow engine's node
 * suites held: their subject was never the engine but the behaviour the loop
 * now owns, so one harness replaces four node fixtures.
 */

const scripted = vi.hoisted(() => ({
  /** The run a scenario drives; the faked extraction locates its files. */
  runId: '' as string,
  /** Per round: what the compile check reports, when it reports at all. */
  compileResults: new Map<number, CompileResult | undefined>(),
  /** Whether the round summary lists its outputs as files to open. */
  openFiles: false,
}));

vi.mock(
  '@agent/implementations/flows/reflection/output/compileCheck',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@agent/implementations/flows/reflection/output/compileCheck')
    >()),
    runCompileCheck: vi.fn(async (_context: unknown, round: number) => ({
      compileResult: scripted.compileResults.get(round),
      artifacts: [],
    })),
  }),
);

vi.mock(
  '@agent/implementations/flows/reflection/output/outputFileExtraction',
  async (importOriginal) => {
    const { ensureRoundData } =
      await import('@agent/implementations/flows/reflection/output/outputState');
    const { createRunStorageLocation: locate } =
      await import('@utils/files/fileLocation');
    type OutputState = Parameters<typeof ensureRoundData>[0];
    return {
      ...(await importOriginal<
        typeof import('@agent/implementations/flows/reflection/output/outputFileExtraction')
      >()),
      extractFilesFromXml: vi.fn(
        async (
          outputState: OutputState,
          _deps: unknown,
          _xml: unknown,
          _location: unknown,
          round: number,
        ) => {
          ensureRoundData(outputState, round).outputs = [
            {
              source: 'main.tex',
              round,
              location: locate(
                `/storage/executions/${scripted.runId}/r${round}/main.tex`,
                `r${round}/main.tex`,
                scripted.runId as RunId,
              ),
              lineage: null,
              diff: null,
            },
          ];
        },
      ),
    };
  },
);

vi.mock(
  '@agent/implementations/flows/reflection/output/lineageMapping',
  () => ({ traceFileLineage: vi.fn(() => ({ files: [] })) }),
);

vi.mock(
  '@agent/implementations/flows/reflection/output/LatexDiffManager',
  () => ({
    LatexDiffManager: class {
      handleLatexdiffOfOutput = async () => [];
    },
  }),
);

vi.mock(
  '@agent/implementations/flows/reflection/output/XmlOutputManager',
  () => ({
    XmlOutputManager: class {
      ensureCorrectXmlStructure = async () => undefined;
    },
  }),
);

vi.mock(
  '@agent/implementations/flows/reflection/output/roundSummary',
  async () => {
    const { ensureRoundData } =
      await import('@agent/implementations/flows/reflection/output/outputState');
    type OutputState = Parameters<typeof ensureRoundData>[0];
    return {
      summarizeRound: vi.fn(
        async (
          outputState: OutputState,
          _deps: unknown,
          _location: unknown,
          round: number,
        ) => {
          const outputs = ensureRoundData(outputState, round).outputs;
          return {
            fileInfos: outputs,
            filesToOpen: scripted.openFiles
              ? outputs.map((output) => output.location)
              : [],
          };
        },
      ),
    };
  },
);

vi.mock(
  '@agent/implementations/flows/reflection/output/outputValidation',
  () => ({ checkExpectedOutputs: vi.fn(async () => ({ missing: [] })) }),
);

vi.mock(
  '@agent/implementations/flows/reflection/output/snapshotResolution',
  () => ({ resolveBaseFilesForDiff: vi.fn(async () => []) }),
);

vi.mock('@agent/prompt/PromptBuilder', () => ({
  getSystemPromptWithRules: vi.fn(async () => 'system'),
  PromptBuilder: class {
    buildInitialPrompts = async () => ({
      userPrefix: '',
      userRequest: 'Write the document.',
    });

    buildUserRequest = async (round: number) => `Revise for round ${round}.`;
  },
}));

setupPlatform({
  storagePath: '/storage',
  workspacePath: '/workspace',
  workspaceState: {
    [WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE]: true,
  },
});

const ORIGIN = {
  protocol: 'deepseek-chat',
  codecVersion: 1,
  requestedModel: 'test-model',
  deployment: {
    endpoint: 'https://api.example.test/v1',
    credentialScope: 'deepseek',
  },
} as const;

/** A `Model` the harness never reaches: the invoker seam is faked above it. */
const unusedModel = new Proxy({} as Model, {
  get(_target, property) {
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

type ScriptedFinish = 'stop' | 'length' | 'context-window-exceeded';

/** What the faked invoker reports for one turn, in script order. */
type ScriptedTurn =
  | { readonly finish: ScriptedFinish; readonly text?: string }
  | { readonly failWith: RetryErrorInfo };

const COMPLETE: ScriptedTurn = { finish: 'stop' };
const CUT_OFF: ScriptedTurn = { finish: 'length' };

function textTurn(text: string, finish: ScriptedFinish): TurnResult {
  return {
    kind: 'http',
    providerResponseId: randomUUID(),
    requestedOrigin: ORIGIN,
    returnedModel: null,
    modelFingerprint: null,
    content: [{ kind: 'message', content: [{ kind: 'text', text }] }],
    finishReason: finish,
    usage: null,
  };
}

function compileFailure(round: number): CompileResult {
  const location = createRunStorageLocation(
    `/storage/executions/${scripted.runId}/r${round}/main.tex`,
    `r${round}/main.tex`,
    scripted.runId as RunId,
  );
  return {
    status: 'failed',
    round,
    failures: [
      {
        round,
        displayName: 'main.tex',
        output: location,
        log: location,
        logRelativePath: `compile/r${round}_main.tex.log`,
      },
    ],
    logExcerpt: '! Missing $ inserted.',
  };
}

interface LoopInit {
  readonly runId: RunId;
  readonly session: SessionHandle;
  readonly rounds: number;
  readonly resume?: boolean;
  readonly logger?: TraceEmitter;
  /** Turns in call order; the script ends in completed turns. */
  readonly turns?: readonly ScriptedTurn[];
  /** Runs inside the invoker before it answers, for interrupt scenarios. */
  readonly beforeResponse?: (round: number) => Effect.Effect<void>;
}

function invokerLayer(init: LoopInit, requests: InvokeRequest[]) {
  return Layer.effect(
    ModelInvoker,
    Effect.gen(function* () {
      const run = yield* AgentRun;
      const ledger = yield* RunLedger;
      const aggregateId = rowAggregate(run.runId);
      return {
        invoke: (state: RunState, request: InvokeRequest) =>
          Effect.gen(function* () {
            const turnScript = init.turns?.[requests.length] ?? COMPLETE;
            requests.push(request);
            if (init.beforeResponse) yield* init.beforeResponse(request.round);
            if ('failWith' in turnScript) {
              const failed = yield* ledger.appendBatch(run.runId, state, [
                runtimeSnapshotRow(run.runId, state, {
                  lastError: turnScript.failWith,
                  pendingRetry: null,
                  declinedRoutes: [],
                }),
              ]);
              return {
                kind: 'failed' as const,
                state: failed,
                error: turnScript.failWith,
              };
            }
            const bound = yield* SynchronizedRef.get(run.model);
            const invocation = { invocationId: randomUUID(), attempt: 1 };
            const responseId = randomUUID();
            const turn = textTurn(
              turnScript.text ?? `round ${request.round} output`,
              turnScript.finish,
            );
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
                  calls: [],
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

function agentRunTestLayer(init: LoopInit) {
  return Layer.effect(
    AgentRun,
    Effect.gen(function* () {
      const model = yield* SynchronizedRef.make(testBoundModel());
      const logger = init.logger ?? new TraceEmitter();
      const scope = yield* Effect.scope;
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
          agent: 'correct',
          model: 'test-model',
          agentCategory: AgentCategory.Workflow,
        }),
        setting: AgentSettingSchema.parse({
          agentCategory: AgentCategory.Workflow,
          rounds: init.rounds,
        }),
        prompt: AgentPromptSchema.parse({ userRequest: 'Write the document.' }),
        logger,
        parentStage: logger.openStage('Run: correct'),
        // The launch stores a real run carries; no fixture reads through them.
        stores: hostStores(),
        toolPolicy: { stopAfterCycle: false },
        userVarChannels: {},
        initialUserMessageForTranscript: 'Write the document.',
        fileService: new TaskRunFileService(init.runId),
        tools: new MapToolRegistry({}),
        finalToolName: null,
        structured: { value: undefined },
        model,
        scope,
        declinedRoutes: [],
        pendingModelSwitch: { value: null },
        inScope: <A>(operation: () => A): A =>
          withRunContext(createRunContext({ runScope }), operation),
        usageMonitor: new UsageMonitor(
          { logger, runId: init.runId, runStageId: undefined },
          { agentName: 'correct', agentCategory: AgentCategory.Workflow },
        ),
        callbacks: { onModelChanged: vi.fn() },
        interrupt: vi.fn(),
      } satisfies AgentRunShape;
    }),
  );
}

function loopProgram(init: LoopInit, requests: InvokeRequest[]) {
  return runReflection({ resume: init.resume === true }).pipe(
    Effect.provide(
      invokerLayer(init, requests).pipe(
        Layer.provideMerge(agentRunTestLayer(init)),
        Layer.provideMerge(Layer.succeed(RunLedger)(init.session.ledger)),
      ),
    ),
  );
}

/** Run one scripted reflection run to its own exit. */
const runLoop = Effect.fn('test.runReflection')(function* (init: LoopInit) {
  const requests: InvokeRequest[] = [];
  const result = yield* loopProgram(init, requests);
  const state = yield* loadState(init);
  return { result, requests, state };
});

const loadState = Effect.fn('test.loadState')(function* (init: LoopInit) {
  const state = yield* init.session.ledger.load(init.runId).pipe(Effect.orDie);
  if (state === null) throw new Error('The run wrote no ledger state.');
  return state;
});

/**
 * Start a run and interrupt it once the invoker is reached in `round`, the
 * way a host stop lands mid-turn; returns the state the halt left behind.
 */
const interruptedAt = Effect.fn('test.interruptedAt')(function* (
  init: LoopInit,
  round: number,
) {
  const reached = yield* Deferred.make<void>();
  const fiber = yield* Effect.forkDetach(
    loopProgram(
      {
        ...init,
        beforeResponse: (current) =>
          current === round
            ? Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Effect.never),
              )
            : Effect.void,
      },
      [],
    ),
  );
  yield* Deferred.await(reached);
  yield* Fiber.interrupt(fiber);
  return yield* loadState(init);
});

function startedRun(session: SessionHandle): RunId {
  const runId = generateRunId();
  scripted.runId = runId;
  scripted.compileResults.clear();
  scripted.openFiles = false;
  publishTestRunStart(session, runId);
  return runId;
}

/** Flip the compile-rejection policy under a run already in flight. */
const setRejectOnCompileFailure = (enabled: boolean) =>
  Effect.promise(() =>
    installedHost().roots.workspaceState.update(
      WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
      enabled,
    ),
  );

/** The verdict each round stage closed with, in transcript order. */
function roundStageOutcomes(store: StreamLog): unknown[] {
  return store
    .toJSON()
    .flatMap((entry) =>
      entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_END &&
      isObject(entry.data) &&
      entry.data.kind === 'round'
        ? [entry.data.status]
        : [],
    );
}

const REJECTED = 'previous workflow round was rejected';
const CUT_OFF_PROMPT = 'Your response got cut off';

/** The plain text of every user message the run recorded. */
function userTexts(state: RunState): string[] {
  return state.messages.flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((part) =>
          part.kind === 'text' ? [part.text] : [],
        )
      : [],
  );
}

/** The persisted reflection state of a folded run. */
function flowOf(state: RunState) {
  const flow = reflectionFlowState(state);
  if (flow === null) throw new Error('The run persisted no reflection state.');
  return flow;
}

const PROVIDER_FAILURE: RetryErrorInfo = {
  message: 'provider failed',
  userRetryable: true,
};

describe('the reflection round loop', () => {
  it.effect('runs its configured rounds and completes', () =>
    Effect.gen(function* () {
      const session = createProcessSession();
      const runId = startedRun(session);
      const { result, requests, state } = yield* runLoop({
        runId,
        session,
        rounds: 2,
      });

      expect(requests.map((request) => request.round)).toEqual([0, 1]);
      expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      expect(state.step).toBe('halted');
      expect(state.outcome).toBe(RUN_OUTCOME.COMPLETED);
    }),
  );

  it.effect(
    'repairs a rejected compile in the next round and completes when that round compiles',
    () =>
      Effect.gen(function* () {
        const session = createProcessSession();
        const runId = startedRun(session);
        scripted.compileResults.set(0, compileFailure(0));
        scripted.compileResults.set(1, { status: 'ok', round: 1 });

        const { result, state } = yield* runLoop({ runId, session, rounds: 2 });

        const repairPrompt = userTexts(state).at(-1) ?? '';
        expect(repairPrompt).toContain(REJECTED);
        expect(repairPrompt).toContain('! Missing $ inserted.');
        expect(flowOf(state).unresolvedCompileRejection).toBeUndefined();
        expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      }),
  );

  it.effect('fails a single-round run whose only compile was rejected', () =>
    Effect.gen(function* () {
      const session = createProcessSession();
      const runId = startedRun(session);
      scripted.compileResults.set(0, compileFailure(0));

      const { result, requests, state } = yield* runLoop({
        runId,
        session,
        rounds: 1,
      });

      expect(requests).toHaveLength(1);
      expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
      expect(result.error).toBeUndefined();
      expect(flowOf(state).unresolvedCompileRejection).toBe(true);
    }),
  );

  it.effect(
    'keeps the rejection when the repair round reports no compile',
    () =>
      Effect.gen(function* () {
        const session = createProcessSession();
        const runId = startedRun(session);
        scripted.compileResults.set(0, compileFailure(0));

        const { result, state } = yield* runLoop({ runId, session, rounds: 2 });

        expect(flowOf(state).compileFailureContext).toBeUndefined();
        expect(flowOf(state).unresolvedCompileRejection).toBe(true);
        expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
      }),
  );

  it.effect('never adds a repair round beyond the configured count', () =>
    Effect.gen(function* () {
      const session = createProcessSession();
      const runId = startedRun(session);
      for (const round of [0, 1, 2]) {
        scripted.compileResults.set(round, compileFailure(round));
      }

      const { result, requests, state } = yield* runLoop({
        runId,
        session,
        rounds: 3,
      });

      expect(requests.map((request) => request.round)).toEqual([0, 1, 2]);
      expect(
        userTexts(state).filter((text) => text.includes(REJECTED)),
      ).toHaveLength(2);
      expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
    }),
  );

  it.effect('accepts a rejected compile while the reject policy is off', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({
          storagePath: '/storage',
          workspacePath: '/workspace',
          workspaceState: {
            [WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE]: false,
          },
        }),
      );
      const session = createProcessSession();
      const runId = startedRun(session);
      scripted.compileResults.set(0, compileFailure(0));

      const { result, state } = yield* runLoop({ runId, session, rounds: 1 });

      expect(flowOf(state).unresolvedCompileRejection).toBeUndefined();
      expect(userTexts(state).at(-1)).not.toContain('rejected');
      expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
    }),
  );

  it.effect(
    'accepts a recorded rejection once the policy is turned off before a final round without a compile',
    () =>
      Effect.gen(function* () {
        // Disabling rejection is an explicit acceptance decision: a repair
        // round that reports no compile result is then a completed run, not
        // a retroactively failed one.
        const session = createProcessSession();
        const runId = startedRun(session);
        scripted.compileResults.set(0, compileFailure(0));

        const { result, requests, state } = yield* runLoop({
          runId,
          session,
          rounds: 2,
          beforeResponse: (round) =>
            round === 1 ? setRejectOnCompileFailure(false) : Effect.void,
        });

        expect(requests.map((request) => request.round)).toEqual([0, 1]);
        expect(userTexts(state).at(-1)).toContain(REJECTED);
        expect(flowOf(state).compileFailureContext).toBeUndefined();
        expect(flowOf(state).unresolvedCompileRejection).toBeUndefined();
        expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      }),
  );

  it.effect(
    'keeps the rejection durable when the repair round is interrupted, and repairs it on resume',
    () =>
      Effect.gen(function* () {
        const session = createProcessSession();
        const runId = startedRun(session);
        scripted.compileResults.set(0, compileFailure(0));
        scripted.compileResults.set(1, { status: 'ok', round: 1 });

        const halted = yield* interruptedAt({ runId, session, rounds: 2 }, 1);

        // The repair prompt was consumed into the round, so the one-shot
        // feedback is gone, while the durable rejection survives the stop.
        expect(halted.outcome).toBe(RUN_OUTCOME.CANCELLED);
        expect(userTexts(halted).at(-1)).toContain(REJECTED);
        expect(flowOf(halted).compileFailureContext).toBeUndefined();
        expect(flowOf(halted).unresolvedCompileRejection).toBe(true);

        const resumed = yield* runLoop({
          runId,
          session,
          rounds: 2,
          resume: true,
        });
        expect(resumed.requests.map((request) => request.round)).toEqual([1]);
        expect(
          flowOf(resumed.state).unresolvedCompileRejection,
        ).toBeUndefined();
        expect(resumed.result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      }),
  );

  it.effect(
    'warns and continues when the run workspace cannot be prepared',
    () =>
      Effect.gen(function* () {
        const session = createProcessSession();
        const runId = startedRun(session);
        const logger = new TraceEmitter();
        const warn = vi.spyOn(logger, 'warn');
        const prepare = vi
          .spyOn(TaskRunFileService.prototype, 'prepareRunWorkspace')
          .mockRejectedValueOnce(new Error('workspace unavailable'));

        try {
          const { result } = yield* runLoop({
            runId,
            session,
            rounds: 1,
            logger,
          });

          expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
          expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('workspace unavailable'),
            expect.objectContaining({ data: expect.any(Error) }),
          );
        } finally {
          prepare.mockRestore();
        }
      }),
  );

  // #8137: every round stage closes with the round's own verdict.
  it.effect.each([
    {
      name: 'completed',
      turns: [COMPLETE, COMPLETE] as ScriptedTurn[],
      outcomes: [RUN_OUTCOME.COMPLETED, RUN_OUTCOME.COMPLETED],
    },
    {
      name: 'failed',
      turns: [COMPLETE, { failWith: PROVIDER_FAILURE }] as ScriptedTurn[],
      outcomes: [RUN_OUTCOME.COMPLETED, RUN_OUTCOME.FAILED],
    },
  ])('closes each round stage with its verdict ($name)', (scenario) =>
    Effect.gen(function* () {
      const session = createProcessSession();
      const runId = startedRun(session);
      const logger = new TraceEmitter();
      const store = new StreamLog();
      const recorder = attachTestTranscriptFold(logger, runId, store);

      try {
        const { result } = yield* runLoop({
          runId,
          session,
          rounds: 2,
          logger,
          turns: scenario.turns,
        });

        expect(result.outcome).toBe(scenario.outcomes.at(-1));
        expect(roundStageOutcomes(store)).toEqual(scenario.outcomes);
      } finally {
        recorder.unsubscribe();
      }
    }),
  );
});

describe('a resumed reflection run', () => {
  it.effect(
    'fails the persisted rejection when the round cap was lowered',
    () =>
      Effect.gen(function* () {
        const session = createProcessSession();
        const runId = startedRun(session);
        scripted.compileResults.set(0, compileFailure(0));

        const stopped = yield* runLoop({
          runId,
          session,
          rounds: 3,
          turns: [COMPLETE, { failWith: PROVIDER_FAILURE }],
        });
        expect(stopped.result.outcome).toBe(RUN_OUTCOME.FAILED);
        expect(flowOf(stopped.state).unresolvedCompileRejection).toBe(true);

        const resumed = yield* runLoop({
          runId,
          session,
          rounds: 1,
          resume: true,
        });

        expect(resumed.requests).toEqual([]);
        expect(resumed.result.outcome).toBe(RUN_OUTCOME.FAILED);
      }),
  );

  it.effect(
    'resolves the persisted rejection when a raised cap allows a repair',
    () =>
      Effect.gen(function* () {
        const session = createProcessSession();
        const runId = startedRun(session);
        scripted.compileResults.set(0, compileFailure(0));
        scripted.compileResults.set(1, { status: 'ok', round: 1 });

        const stopped = yield* runLoop({
          runId,
          session,
          rounds: 3,
          turns: [COMPLETE, { failWith: PROVIDER_FAILURE }],
        });
        expect(stopped.result.outcome).toBe(RUN_OUTCOME.FAILED);

        const resumed = yield* runLoop({
          runId,
          session,
          rounds: 3,
          resume: true,
        });

        expect(resumed.requests.map((request) => request.round)).toEqual([
          1, 2,
        ]);
        expect(
          flowOf(resumed.state).unresolvedCompileRejection,
        ).toBeUndefined();
        expect(resumed.result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      }),
  );

  it.effect(
    'clears a persisted rejection before the cap fails it once the policy is off',
    () =>
      Effect.gen(function* () {
        const session = createProcessSession();
        const runId = startedRun(session);
        scripted.compileResults.set(0, compileFailure(0));

        const stopped = yield* runLoop({ runId, session, rounds: 1 });
        expect(stopped.result.outcome).toBe(RUN_OUTCOME.FAILED);
        expect(flowOf(stopped.state).unresolvedCompileRejection).toBe(true);

        yield* setRejectOnCompileFailure(false);
        const resumed = yield* runLoop({
          runId,
          session,
          rounds: 1,
          resume: true,
        });

        // The policy is normalized before the round cap is consulted, so
        // the recorded rejection is accepted rather than failed again: the
        // halt row records the accepted run without another round.
        expect(resumed.requests).toEqual([]);
        expect(resumed.result.outcome).toBe(RUN_OUTCOME.COMPLETED);
        expect(resumed.state.outcome).toBe(RUN_OUTCOME.COMPLETED);
      }),
  );
});

describe('the output facts a reflection round publishes', () => {
  it.effect('publishes the run-wide output map, restored rounds included', () =>
    Effect.gen(function* () {
      const session = createProcessSession();
      const runId = startedRun(session);
      const firstLogger = new TraceEmitter();
      const first = recordTraceEvents(firstLogger);

      yield* runLoop({
        runId,
        session,
        rounds: 2,
        logger: firstLogger,
        turns: [COMPLETE, { failWith: PROVIDER_FAILURE }],
      });

      const opened = traceEventsOfType(first.events, 'addOutputFiles');
      expect(Object.keys(opened.at(-1)?.filesByRound ?? {})).toEqual(['0']);

      const resumedLogger = new TraceEmitter();
      const resumed = recordTraceEvents(resumedLogger);
      yield* runLoop({
        runId,
        session,
        rounds: 2,
        resume: true,
        logger: resumedLogger,
      });

      // The row carries the run's whole round map, not the round that just
      // finished: a cold fold keeps only the newest row, so the restored
      // round has to ride along.
      const republished = traceEventsOfType(resumed.events, 'addOutputFiles');
      const filesByRound = republished.at(-1)?.filesByRound ?? {};
      expect(Object.keys(filesByRound)).toEqual(['0', '1']);
      expect((filesByRound[0] as OutputFileInfo[])[0]?.round).toBe(0);
    }),
  );

  it.effect('publishes the compile failures of a rejected round', () =>
    Effect.gen(function* () {
      const session = createProcessSession();
      const runId = startedRun(session);
      const logger = new TraceEmitter();
      const recorded = recordTraceEvents(logger);
      scripted.compileResults.set(0, compileFailure(0));

      yield* runLoop({ runId, session, rounds: 1, logger });

      const failures = traceEventsOfType(
        recorded.events,
        'updateCompileFailures',
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]?.filesByRound[0]).toMatchObject([
        { round: 0, displayName: 'main.tex' },
      ]);
    }),
  );

  it.effect('asks the host to open the files a round summary lists', () =>
    Effect.gen(function* () {
      const session = createProcessSession();
      const { events, interactions } = createRecordingHost();
      session.interactions.use(interactions);
      const runId = startedRun(session);
      scripted.openFiles = true;

      yield* runLoop({ runId, session, rounds: 1 });

      expect(events).toContainEqual({
        event: 'requestOpenFile',
        payload: {
          location: expect.objectContaining({ relativePath: 'r0/main.tex' }),
          preserveFocus: true,
        },
      });
    }),
  );
});

describe('a token-limited reflection response', () => {
  it.effect(
    'continues inside the same round instead of opening a new one',
    () =>
      Effect.gen(function* () {
        const session = createProcessSession();
        const runId = startedRun(session);

        const { result, requests, state } = yield* runLoop({
          runId,
          session,
          rounds: 1,
          turns: [CUT_OFF, COMPLETE],
        });

        expect(requests.map((request) => request.round)).toEqual([0, 0]);
        expect(userTexts(state).at(-1)).toContain(CUT_OFF_PROMPT);
        expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      }),
  );

  it.effect('stops continuing once the continuation limit is reached', () =>
    Effect.gen(function* () {
      // Reflection owns the conversation limit: a model that never finishes
      // gets a bounded number of continuations, then the round ends with what
      // it has.
      const session = createProcessSession();
      const runId = startedRun(session);

      const { result, requests, state } = yield* runLoop({
        runId,
        session,
        rounds: 1,
        turns: Array.from({ length: 12 }, () => CUT_OFF),
      });

      expect(requests).toHaveLength(12);
      expect(requests.every((request) => request.round === 0)).toBe(true);
      expect(
        userTexts(state).filter((text) => text.includes(CUT_OFF_PROMPT)),
      ).toHaveLength(11);
      expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
    }),
  );

  it.effect('joins a continued response through the session text policy', () =>
    Effect.gen(function* () {
      const connectResponseText = vi.fn(() => Effect.succeed('\n'));
      const session = createProcessSession({
        responseTextProcessing: {
          normalizeResponseText: (text: string) => text,
          postProcessResponse: (text: string) => text,
          connectResponseText,
        },
      });
      const runId = startedRun(session);

      const { state } = yield* runLoop({
        runId,
        session,
        rounds: 1,
        turns: [
          { finish: 'length', text: 'left' },
          { finish: 'stop', text: 'right' },
        ],
      });

      const location = flowOf(state).outputLocation;
      if (location === null) throw new Error('The round kept no output.');
      // Every cycle asks the policy how it joins onto what came before; the
      // first has nothing before it, so its connector is never written.
      expect(connectResponseText.mock.calls).toEqual([
        ['', 'left'],
        ['left', 'right'],
      ]);
      expect(
        yield* Effect.promise(() => AbsoluteFS.read(location.absolutePath)),
      ).toBe('left\nright');
    }),
  );

  it.effect.each([
    { name: 'with partial output', text: 'partial response' },
    { name: 'with no output', text: '' },
  ])(
    'stops instead of retrying a context-window overflow ($name)',
    ({ text }) =>
      Effect.gen(function* () {
        // No compaction is available on the reflection path, so a retry
        // would overflow again: the round ends, loudly, with what it has.
        const session = createProcessSession();
        const runId = startedRun(session);
        const logger = new TraceEmitter();
        const warn = vi.spyOn(logger, 'warn');

        const { result, requests, state } = yield* runLoop({
          runId,
          session,
          rounds: 1,
          logger,
          turns: [{ finish: 'context-window-exceeded', text }],
        });

        expect(requests).toHaveLength(1);
        expect(userTexts(state).at(-1)).not.toContain(CUT_OFF_PROMPT);
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining('context window exceeded'),
        );
        expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      }),
  );
});

describe('an interrupted reflection run', () => {
  it.effect('halts as cancelled and leaves a resumable round behind', () =>
    Effect.gen(function* () {
      const session = createProcessSession();
      const runId = startedRun(session);

      const state = yield* interruptedAt({ runId, session, rounds: 2 }, 0);

      expect(state.step).toBe('halted');
      expect(state.outcome).toBe(RUN_OUTCOME.CANCELLED);
      // The round the stop interrupted is still the round a resume reopens.
      expect(flowOf(state).currentRound).toBe(0);

      const resumed = yield* runLoop({
        runId,
        session,
        rounds: 2,
        resume: true,
      });
      expect(resumed.result.outcome).toBe(RUN_OUTCOME.COMPLETED);
    }),
  );

  it.effect(
    'keeps a completed round when the next one is interrupted, and resumes after it',
    () =>
      Effect.gen(function* () {
        const session = createProcessSession();
        const runId = startedRun(session);
        const logger = new TraceEmitter();
        const store = new StreamLog();
        const recorder = attachTestTranscriptFold(logger, runId, store);

        try {
          const halted = yield* interruptedAt(
            { runId, session, rounds: 2, logger },
            1,
          );

          // The first round's stage closed with its own verdict; only the
          // interrupted one is cancelled, and its outputs stay on the
          // snapshot a resume continues from.
          expect(roundStageOutcomes(store)).toEqual([
            RUN_OUTCOME.COMPLETED,
            RUN_OUTCOME.CANCELLED,
          ]);
          expect(halted.outcome).toBe(RUN_OUTCOME.CANCELLED);
          expect(flowOf(halted).currentRound).toBe(1);
          expect(flowOf(halted).roundOutputs[0]?.outputs).toHaveLength(1);
        } finally {
          recorder.unsubscribe();
        }

        const resumed = yield* runLoop({
          runId,
          session,
          rounds: 2,
          resume: true,
        });
        expect(resumed.requests.map((request) => request.round)).toEqual([1]);
        expect(resumed.result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      }),
  );
});
