/**
 * A workflow agent's loop-boundary suite: `runToolUse` in round mode (the
 * documents plugin's rounds) driven over a real session ledger with the
 * model faked at the `ModelInvoker` seam. It pins what the durable rows must
 * say at the boundary — the round loop's compile repair, resume from the
 * rows, the output facts a round publishes, the token-limited response, and
 * the interrupt.
 */
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Layer, SynchronizedRef } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import { rowAggregate, snapshotRow, stepRow } from '@agent/runtime/loop/rows';
import { runToolUse } from '@agent/runtime/loop/toolUse';
import { ModelInvoker, type InvokeRequest } from '@agent/runtime/ModelInvoker';
import { AgentRun, type AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import { turnText } from '@agent/runtime/run/turnText';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import { TraceEmitter } from '@agent/trace';
import { Runs } from '@agent/runtime/runRegistry';
import type { RunCell } from '@agent/runtime/loop/runProgram';
import { StateReadFailed } from '@platform/interfaces';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import {
  AgentCategory,
  RUN_OUTCOME,
  type CompileResult,
  type RetryErrorInfo,
  type RunId,
} from '@shared/schemas';
import {
  WORKFLOW_RAW_OUTPUT_EXT,
  workflowOutputPath,
} from '@shared/constants/workflowOutput';
import { RunLedger } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { emptyPinnedComposition } from '@test/support/nativeToolTestLayer';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { rootedFsLayer } from '@test/support/fsTestUtils';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
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
import { FakeStateStore, fakePath } from '@test/support/FakePlatform';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { CompositionKey } from '@tools/compositions';
import { generateRunId } from '@utils/core';
import { createRunStorageLocation } from '@utils/files/fileLocation';
import { RunFileService } from '@utils/files/runStorage';

import { createRecordingHost } from './progressTestUtils';

import type { Model, TurnResult } from '@texra-ai/llm/turn';

/**
 * Round mode over a real session ledger: the round loop, the
 * compile-rejection policy, the cut-off round and resume are production
 * code; the model is faked at the `ModelInvoker` seam and the round's output
 * pipeline at its module seams, so a scenario scripts turns and compile
 * verdicts and the loop decides what to do with them.
 */

const scripted = vi.hoisted(() => ({
  /** The run a scenario drives; the faked extraction locates its files. */
  runId: '' as string,
  /** Per round: what the compile check reports, when it reports at all. */
  compileResults: new Map<number, CompileResult | undefined>(),
  /** Whether the round summary lists its outputs as files to open. */
  openFiles: false,
}));

vi.mock('@agent/output/compileCheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/output/compileCheck')>()),
  runCompileCheck: vi.fn((_context: unknown, round: number) =>
    Effect.sync(() => ({
      compileResult: scripted.compileResults.get(round),
      artifacts: [],
    })),
  ),
}));

vi.mock('@agent/output/outputFileExtraction', async (importOriginal) => {
  const { ensureRoundData } = await import('@agent/output/outputState');
  const { createRunStorageLocation: locate } =
    await import('@utils/files/fileLocation');
  type OutputState = Parameters<typeof ensureRoundData>[0];
  return {
    ...(await importOriginal<
      typeof import('@agent/output/outputFileExtraction')
    >()),
    extractFilesFromXml: vi.fn(
      (
        outputState: OutputState,
        _deps: unknown,
        _xml: unknown,
        _outputLocation: unknown,
        round: number,
      ) =>
        Effect.sync(() => {
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
        }),
    ),
  };
});

vi.mock('@agent/output/lineageMapping', () => ({
  traceFileLineage: vi.fn(() => ({ files: [] })),
}));

vi.mock('@agent/output/LatexDiffManager', () => ({
  LatexDiffManager: class {
    handleLatexdiffOfOutput = () => Effect.succeed([]);
  },
}));

vi.mock('@agent/output/XmlOutputManager', () => ({
  XmlOutputManager: class {
    ensureCorrectXmlStructure = () => Effect.void;
  },
}));

vi.mock('@agent/output/roundSummary', async () => {
  const { ensureRoundData } = await import('@agent/output/outputState');
  type OutputState = Parameters<typeof ensureRoundData>[0];
  return {
    summarizeRound: vi.fn(
      (
        outputState: OutputState,
        _deps: unknown,
        _location: unknown,
        round: number,
      ) =>
        Effect.sync(() => {
          const outputs = ensureRoundData(outputState, round).outputs;
          return {
            filesToOpen: scripted.openFiles
              ? outputs.map((output) => output.location)
              : [],
          };
        }),
    ),
  };
});

vi.mock('@agent/output/outputValidation', () => ({
  checkExpectedOutputs: vi.fn(() => Effect.succeed({ missing: [] })),
}));

vi.mock('@agent/prompt/PromptBuilder', () => ({
  getSystemPromptWithRules: vi.fn(() => Effect.succeed('system')),
  PromptBuilder: class {
    buildInitialPrompts = () =>
      Effect.succeed({
        userPrefix: '',
        userRequest: 'Write the document.',
      });

    buildUserRequest = (round: number) =>
      Effect.succeed(`Revise for round ${round}.`);
  },
}));

setupPlatform({
  storagePath: fakePath('storage'),
  workspacePath: fakePath('workspace'),
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

/** The pinned composition of a workflow run: the documents plugin's rounds. */
const DOCUMENTS_COMPOSITION = {
  ...emptyPinnedComposition,
  key: new CompositionKey('0'.repeat(64), {
    ...emptyPinnedComposition.key.composition,
    plugins: ['documents'],
  }),
};

function testBoundModel(): BoundModel {
  return {
    modelId: 'test-model',
    config: buildTestModelConfig(),
    compatibilityKey: 'DeepSeek',
    model: unusedModel,
    origin: ORIGIN,
    route: { kind: 'api-key', provider: 'deepseek', usageRoute: 'api-key' },
    usageRoute: 'api-key',
    contextWindow: 200_000,
    supportsVision: false,
    supportsNativePdf: false,
    supportsNativeAudio: false,
    supportsForcedToolChoice: true,
    wireRouteKey: 'test-route',
    modelRetryRouteKey: 'test-route/test-model',
    backgroundCapable: false,
  };
}

type ScriptedFinish = 'stop' | 'length' | 'context-window-exceeded';

/** What the faked invoker reports for one turn, in script order. */
type ScriptedTurn =
  | { readonly finish: ScriptedFinish; readonly text?: string }
  | { readonly failWith: RetryErrorInfo };

const COMPLETE: ScriptedTurn = { finish: 'stop' };

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
  /** Runs after the invoker committed its response rows, before it answers:
   *  the crash point between a paid response and the output write. */
  readonly afterResponse?: (round: number) => Effect.Effect<void>;
}

function invokerLayer(init: LoopInit, requests: InvokeRequest[]) {
  return Layer.effect(
    ModelInvoker,
    Effect.gen(function* () {
      const run = yield* AgentRun;
      const aggregateId = rowAggregate(run.runId);
      return {
        invoke: (cell: RunCell, request: InvokeRequest) =>
          Effect.gen(function* () {
            const state = yield* cell.current;
            const turnScript = init.turns?.[requests.length] ?? COMPLETE;
            requests.push(request);
            if (init.beforeResponse) yield* init.beforeResponse(request.round);
            if ('failWith' in turnScript) {
              const failed = yield* cell.append([
                snapshotRow(run.runId, state, {
                  runtime: {
                    lastError: turnScript.failWith,
                    declinedRoutes: [],
                  },
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
            const next = yield* cell.append([
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
              // As the invoker does: the response retires a recorded failure.
              ...(state.lastError === null
                ? []
                : [
                    snapshotRow(run.runId, state, {
                      runtime: { lastError: null },
                    }),
                  ]),
              stepRow(run.runId, state, 'response.ready'),
            ]);
            if (init.afterResponse) yield* init.afterResponse(request.round);
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
      return {
        runId: init.runId,
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
        fileService: new RunFileService(init.runId, init.session.roots),
        tools: new MapToolRegistry({}),
        finalToolName: null,
        toolset: { offeredTools: [], toolsetHash: '0'.repeat(64) },
        composition: DOCUMENTS_COMPOSITION,
        structured: { value: undefined },
        model,
        scope,
        declinedRoutes: [],
        pendingModelSwitch: { value: null },
        usageMonitor: new UsageMonitor(
          {
            logger,
            runId: init.runId,
            runStageId: undefined,
            config: testWorkspaceRoots().config,
            usageLog: { log: () => {} },
          },
          { agentName: 'correct', agentCategory: AgentCategory.Workflow },
        ),
        callbacks: {},
      } satisfies AgentRunShape;
    }),
  );
}

function loopProgram(init: LoopInit, requests: InvokeRequest[]) {
  return runToolUse({ resume: init.resume === true }).pipe(
    Effect.provide(
      invokerLayer(init, requests).pipe(
        Layer.provideMerge(agentRunTestLayer(init)),
        Layer.provideMerge(Layer.succeed(RunLedger)(init.session.ledger)),
        Layer.provideMerge(Layer.succeed(Runs)(init.session.runs)),
        Layer.provideMerge(rootedFsLayer(init.session.roots)),
        Layer.provideMerge(
          LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT),
        ),
        Layer.provideMerge(testHttpClientLayer),
        Layer.provideMerge(nodeSpawnerLayer),
        Layer.provideMerge(Layer.effectContext(testRuntime().contextEffect)),
      ),
    ),
  );
}

/** Run one scripted workflow run to its own exit. */
const runLoop = Effect.fn('test.runRounds')(function* (init: LoopInit) {
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
 * `at` picks the side of the invoker's own commit the stop lands on.
 */
const interruptedAt = Effect.fn('test.interruptedAt')(function* (
  init: LoopInit,
  round: number,
  at: 'beforeResponse' | 'afterResponse' = 'beforeResponse',
) {
  const reached = yield* Deferred.make<void>();
  const park = (current: number) =>
    current === round
      ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
      : Effect.void;
  const fiber = yield* Effect.forkDetach(
    loopProgram(
      {
        ...init,
        beforeResponse: at === 'beforeResponse' ? park : undefined,
        afterResponse: at === 'afterResponse' ? park : undefined,
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

/**
 * Flip the compile-rejection policy under a run already in flight. The fake
 * host's store is an in-memory map, whose write cannot fail, so the hook the
 * invoker awaits stays an infallible program and a refusal would be a defect.
 */
const setRejectOnCompileFailure = (enabled: boolean) =>
  installedHost()
    .roots.workspaceState.update(
      WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
      enabled,
    )
    .pipe(Effect.orDie);

/** The verdict each round stage closed with, in transcript order. */
function roundStageOutcomes(
  recorder: ReturnType<typeof attachTestTranscriptFold>,
): unknown[] {
  return recorder
    .transcript()
    .taskGroups.flatMap((group) =>
      group.kind === 'round' && group.endTime !== undefined
        ? [group.status]
        : [],
    );
}

const REJECTED = 'previous workflow round was rejected';

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

/** The canonical raw output a round's pipeline reads, as the loop derives it
 *  from the round. */
function canonicalOutputOf(
  session: SessionHandle,
  runId: RunId,
  round: number,
): string {
  return new RunFileService(runId, session.roots).createLocation(
    workflowOutputPath({ ext: WORKFLOW_RAW_OUTPUT_EXT, round }),
  ).absolutePath;
}

const PROVIDER_FAILURE: RetryErrorInfo = {
  message: 'provider failed',
  userRetryable: true,
};

describe('the workflow round loop', () => {
  it.effect('runs its configured rounds and completes', () =>
    Effect.gen(function* () {
      const session = yield* createProcessSession();
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
        const session = yield* createProcessSession();
        const runId = startedRun(session);
        scripted.compileResults.set(0, compileFailure(0));
        scripted.compileResults.set(1, { status: 'ok', round: 1 });

        const { result, state } = yield* runLoop({ runId, session, rounds: 2 });

        const repairPrompt = userTexts(state).at(-1) ?? '';
        expect(repairPrompt).toContain(REJECTED);
        expect(repairPrompt).toContain('! Missing $ inserted.');
        expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      }),
  );

  it.effect('fails a single-round run whose only compile was rejected', () =>
    Effect.gen(function* () {
      const session = yield* createProcessSession();
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
    }),
  );

  it.effect(
    'keeps the rejection when the repair round reports no compile',
    () =>
      Effect.gen(function* () {
        const session = yield* createProcessSession();
        const runId = startedRun(session);
        scripted.compileResults.set(0, compileFailure(0));

        const { result, state } = yield* runLoop({ runId, session, rounds: 2 });

        expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
      }),
  );

  it.effect('never adds a repair round beyond the configured count', () =>
    Effect.gen(function* () {
      const session = yield* createProcessSession();
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
          storagePath: fakePath('storage'),
          workspacePath: fakePath('workspace'),
          workspaceState: {
            [WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE]: false,
          },
        }),
      );
      const session = yield* createProcessSession();
      const runId = startedRun(session);
      scripted.compileResults.set(0, compileFailure(0));

      const { result, state } = yield* runLoop({ runId, session, rounds: 1 });

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
        const session = yield* createProcessSession();
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
        expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      }),
  );

  it.effect(
    'keeps the rejection durable when the repair round is interrupted, and repairs it on resume',
    () =>
      Effect.gen(function* () {
        const session = yield* createProcessSession();
        const runId = startedRun(session);
        scripted.compileResults.set(0, compileFailure(0));
        scripted.compileResults.set(1, { status: 'ok', round: 1 });

        const halted = yield* interruptedAt({ runId, session, rounds: 2 }, 1);

        // The repair prompt was consumed into the round, while the rejection
        // survives the stop in the rows a resume reads.
        expect(halted.outcome).toBe(RUN_OUTCOME.CANCELLED);
        expect(userTexts(halted).at(-1)).toContain(REJECTED);

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

  it.effect(
    'warns and continues when the run workspace cannot be prepared',
    () =>
      Effect.gen(function* () {
        const session = yield* createProcessSession();
        const runId = startedRun(session);
        const logger = new TraceEmitter();
        const warn = vi.spyOn(logger, 'warn');
        const prepare = vi
          .spyOn(RunFileService.prototype, 'prepareRunWorkspace')
          .mockReturnValueOnce(Effect.fail(new Error('workspace unavailable')));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => prepare.mockRestore()),
        );

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
      const session = yield* createProcessSession();
      const runId = startedRun(session);
      const logger = new TraceEmitter();
      const recorder = attachTestTranscriptFold(logger, runId);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => recorder.unsubscribe()),
      );

      const { result } = yield* runLoop({
        runId,
        session,
        rounds: 2,
        logger,
        turns: scenario.turns,
      });

      expect(result.outcome).toBe(scenario.outcomes.at(-1));
      expect(roundStageOutcomes(recorder)).toEqual(scenario.outcomes);
    }),
  );
});

describe('a resumed workflow run', () => {
  it.effect(
    'fails the persisted rejection when the round cap was lowered',
    () =>
      Effect.gen(function* () {
        const session = yield* createProcessSession();
        const runId = startedRun(session);
        scripted.compileResults.set(0, compileFailure(0));

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
        const session = yield* createProcessSession();
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
        expect(resumed.result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      }),
  );

  it.effect(
    'clears a persisted rejection before the cap fails it once the policy is off',
    () =>
      Effect.gen(function* () {
        const session = yield* createProcessSession();
        const runId = startedRun(session);
        scripted.compileResults.set(0, compileFailure(0));

        const stopped = yield* runLoop({ runId, session, rounds: 1 });
        expect(stopped.result.outcome).toBe(RUN_OUTCOME.FAILED);

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

describe('the output facts a workflow round publishes', () => {
  it.effect('keeps extracted outputs when presentation settings fail', () =>
    Effect.gen(function* () {
      const stateStore = new FakeStateStore();
      yield* Effect.promise(() =>
        installPlatform(
          {
            storagePath: fakePath('storage'),
            workspacePath: fakePath('workspace'),
          },
          {
            workspaceState: {
              get: <T>(key: string, defaultValue?: T) =>
                key === WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF
                  ? Effect.fail(
                      new StateReadFailed({
                        key,
                        message: 'Cannot read auto-open setting',
                        cause: new Error('read failed'),
                      }),
                    )
                  : stateStore.get(key, defaultValue),
              update: (key, value) => stateStore.update(key, value),
            },
          },
        ),
      );
      const session = yield* createProcessSession();
      const runId = startedRun(session);
      const init = { runId, session, rounds: 1 };

      const exit = yield* Effect.exit(loopProgram(init, []));
      const state = yield* loadState(init);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(state.roundOutputs[0]?.outputs[0]?.location).toMatchObject({
        relativePath: 'r0/main.tex',
      });
    }),
  );

  it.effect('publishes the run-wide output map, restored rounds included', () =>
    Effect.gen(function* () {
      const session = yield* createProcessSession();
      const runId = startedRun(session);
      const firstLogger = new TraceEmitter();

      const first = yield* runLoop({
        runId,
        session,
        rounds: 2,
        logger: firstLogger,
        turns: [COMPLETE, { failWith: PROVIDER_FAILURE }],
      });

      expect(first.state.roundOutputs.map((round) => round.round)).toEqual([0]);

      const resumedLogger = new TraceEmitter();
      const resumed = yield* runLoop({
        runId,
        session,
        rounds: 2,
        resume: true,
        logger: resumedLogger,
      });

      // The row carries the run's whole round map, not the round that just
      // finished: a cold fold keeps only the newest row, so the restored
      // round has to ride along.
      expect(resumed.state.roundOutputs.map((round) => round.round)).toEqual([
        0, 1,
      ]);
      expect(resumed.state.roundOutputs[0]?.outputs[0]?.round).toBe(0);
    }),
  );

  it.effect('publishes the compile failures of a rejected round', () =>
    Effect.gen(function* () {
      const session = yield* createProcessSession();
      const runId = startedRun(session);
      const logger = new TraceEmitter();
      scripted.compileResults.set(0, compileFailure(0));

      const completed = yield* runLoop({ runId, session, rounds: 1, logger });

      expect(completed.state.roundOutputs[0]?.compileFailures).toMatchObject([
        { round: 0, displayName: 'main.tex' },
      ]);
    }),
  );

  it.effect('asks the host to open the files a round summary lists', () =>
    Effect.gen(function* () {
      const session = yield* createProcessSession();
      const { events, interactions } = createRecordingHost();
      yield* session.interactions.use(interactions);
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

describe('a token-limited workflow response', () => {
  it.effect('processes a cut-off response as the round output, loudly', () =>
    Effect.gen(function* () {
      // A response cut off by the output limit is not continued: its text is
      // the round's output, and the transcript says it may be incomplete.
      const session = yield* createProcessSession();
      const runId = startedRun(session);
      const logger = new TraceEmitter();
      const warn = vi.spyOn(logger, 'warn');

      const { result, requests, state } = yield* runLoop({
        runId,
        session,
        rounds: 1,
        logger,
        turns: [{ finish: 'length', text: 'cut off' }],
      });

      expect(requests).toHaveLength(1);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("hit the model's output limit"),
      );
      expect(
        yield* Effect.promise(() =>
          readFile(canonicalOutputOf(session, runId, 0), 'utf-8'),
        ),
      ).toBe('cut off');
      expect(state.roundOutputs[0]?.outputs).toHaveLength(1);
      expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
    }),
  );

  it.effect.each([
    { name: 'with partial output', text: 'partial response' },
    { name: 'with no output', text: '' },
  ])(
    'stops instead of retrying a context-window overflow ($name)',
    ({ text }) =>
      Effect.gen(function* () {
        // The one-round history is too short to compact, so a retry would
        // overflow again: the round ends, loudly, with what it has.
        const session = yield* createProcessSession();
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
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining('context window exceeded'),
        );
        expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      }),
  );
});

describe('an interrupted workflow run', () => {
  it.effect('halts as cancelled and leaves a resumable round behind', () =>
    Effect.gen(function* () {
      const session = yield* createProcessSession();
      const runId = startedRun(session);

      const state = yield* interruptedAt({ runId, session, rounds: 2 }, 0);

      expect(state.step).toBe('halted');
      expect(state.outcome).toBe(RUN_OUTCOME.CANCELLED);
      // The round the stop interrupted is still the round a resume reopens:
      // round 0 is the run's first turn.
      expect(state.turn).toBe(1);

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
        const session = yield* createProcessSession();
        const runId = startedRun(session);
        const logger = new TraceEmitter();
        const recorder = attachTestTranscriptFold(logger, runId);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => recorder.unsubscribe()),
        );

        const halted = yield* interruptedAt(
          { runId, session, rounds: 2, logger },
          1,
        );

        // The first round's stage closed with its own verdict; only the
        // interrupted one is cancelled, and its outputs stay in the
        // ledger a resume continues from.
        expect(roundStageOutcomes(recorder)).toEqual([
          RUN_OUTCOME.COMPLETED,
          RUN_OUTCOME.CANCELLED,
        ]);
        expect(halted.outcome).toBe(RUN_OUTCOME.CANCELLED);
        expect(halted.turn).toBe(2);
        expect(halted.roundOutputs[0]?.outputs).toHaveLength(1);

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

  /**
   * C15: a crash between the committed response row and the round's raw
   * output write. The response is paid for and durable, so resume reprocesses
   * it and writes the raw output wholesale from the folded response, so
   * debris a crash left in it is rewritten, never reconciled by length.
   */
  it.effect.each([
    { name: 'missing file', seed: false },
    { name: 'canonical debris', seed: true },
  ])(
    'rewrites a reprocessed response from its coordinate ($name)',
    ({ seed }) =>
      Effect.gen(function* () {
        const session = yield* createProcessSession();
        const runId = startedRun(session);
        const halted = yield* interruptedAt(
          { runId, session, rounds: 1 },
          0,
          'afterResponse',
        );
        // The response row is committed; the raw output is not yet written.
        expect(halted.lastTurn).not.toBeNull();
        const canonical = canonicalOutputOf(session, runId, halted.turn - 1);
        yield* Effect.promise(async () => {
          if (!seed) return;
          await mkdir(dirname(canonical), { recursive: true });
          await writeFile(canonical, 'stale bytes from the crash');
        });

        yield* runLoop({ runId, session, rounds: 1, resume: true });

        const content = yield* Effect.promise(() =>
          readFile(canonical, 'utf-8'),
        );
        expect(content).toBe('round 0 output');
      }),
  );
});
