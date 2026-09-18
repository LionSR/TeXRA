// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildAgentLaunchContext: vi.fn(),
  readView: vi.fn(),
  invokeModelOrTool: vi.fn(),
  runFlowWithLifecycle: vi.fn(),
  runToolUse: vi.fn(),
  agentRunLayer: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  releaseClaims: vi.fn(),
}));

vi.mock('@agent/runtime/AgentLaunchContext', async () => {
  const { Effect } = await import('effect');
  return {
    prepareAgentDefinition: ({ config }: { config: unknown }) =>
      Effect.succeed({ config }),
    buildAgentLaunchContext: (...args: unknown[]) =>
      Effect.tryPromise({
        try: () => mocks.buildAgentLaunchContext(...args),
        catch: ensureError,
      }),
  };
});

// The lifecycle wrapper is the Effect the lane hands its runner to; the
// suite's subject is what the lane passes, so the wrapper just runs it.
vi.mock('@agent/runtime/AgentRunLifecycle', () => ({
  runFlowWithLifecycle: (...args: unknown[]) =>
    mocks.runFlowWithLifecycle(...args),
}));

vi.mock('@agent/runtime/loop/toolUse', () => ({
  runToolUse: mocks.runToolUse,
}));

// The per-run services the lane provides are built and exercised by the loop
// suites. Here only the layer's *input* matters: the tools the lane hands the
// run and the callbacks it wires, so the layer itself is empty and its input
// is captured.
vi.mock('@agent/runtime/run/AgentRun', async (importOriginal) => {
  const { Layer } = await import('effect');
  return {
    ...(await importOriginal<typeof import('@agent/runtime/run/AgentRun')>()),
    agentRunLayer: (...args: unknown[]) => {
      mocks.agentRunLayer(...args);
      return Layer.empty;
    },
  };
});

vi.mock('@agent/runtime/ModelInvoker', async () => {
  const { Layer } = await import('effect');
  return { modelInvokerLayer: () => Layer.empty };
});

vi.mock('@agent/runtime/FollowUps', async () => {
  const { Layer } = await import('effect');
  return { followUpsLayer: Layer.empty };
});

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.retrieveSessionResumeData(...args),
      catch: ensureError,
    }),
}));

// Local imports
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import {
  resumeToolUseFromResumeData as resumeOnLane,
  ResumeSessionUnavailableError,
  type ResumeToolUseFromResumeDataOptions,
} from '@agent/runtime/executeAgent';
import {
  RunArtifactDrainError,
  SessionHandle,
} from '@agent/runtime/SessionHandle';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  type RunId,
  AgentCategory,
} from '@shared/schemas';
import { emptySessionView } from '@shared/session/sessionView';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { fakeProcessServices } from '@test/support/setupPlatform';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { ensureError } from '@utils/errors/errorMessage';

/** The part of `ToolUseStart` this suite drives. */
interface InterruptibleLoopStart {
  attachment: {
    attach: (flowContext: TestFlowContext) => void;
    detach: (flowContext: TestFlowContext) => void;
  };
}

interface TestFlowContext {
  interrupt(): void;
}

/** The callbacks the lane wires into the run's `AgentRun` layer. */
interface CapturedRunCallbacks {
  onModelChanged: (model: string) => void;
}

/** Empty totals: this suite never bills a turn. */
const NO_USAGE = {
  firstInputTokens: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
  totalCacheReadInputTokens: 0,
  totalCacheMissInputTokens: 0,
  totalCacheCreationInputTokens: 0,
  totalReasoningTokens: 0,
  totalToolUsePromptTokens: 0,
  totalServerToolRequests: 0,
};

/** The settle the lane's lease release drains; a case may fail it. */
const settlePublications = vi.fn(
  (_runId?: RunId): Effect.Effect<void, Error> => Effect.void,
);

/**
 * The session whose run lane admits the resume. No competing generation
 * exists in this fixture, so the lane is a passthrough.
 */
const LANE_SESSION = {
  // The run layer builds the session's rooted filesystems from these.
  roots: createFakeWorkspaceRoots(),
  runs: {
    launchRun: (_runId: RunId, operation: Effect.Effect<unknown, unknown>) =>
      operation,
    // No parent is detaching this run, so its release waits on nothing.
    throughDetach: () => Effect.void,
  },
  acquireClaims: () => Effect.succeed(Effect.void),
  graph: { releaseClaims: mocks.releaseClaims },
  releaseClaims: SessionHandle.prototype.releaseClaims,
  transcripts: { ensureLoaded: vi.fn(() => Effect.void) },
  // The resumed run reads its parent edge off the session's cold fold, so the
  // lineage fixture is that read.
  readView: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.readView(...args),
      catch: ensureError,
    }),
  status: {},
  settlePublications,
  releaseRunLease: SessionHandle.prototype.releaseRunLease,
} as never;

function resumeToolUseFromResumeData(
  resume: Parameters<typeof resumeOnLane>[0],
  options: ResumeToolUseFromResumeDataOptions = {},
) {
  return Effect.provide(
    resumeOnLane(resume, { session: LANE_SESSION, ...options }),
    fakeProcessServices(),
  );
}

/** Minimal launch context for a resumed tool-use run that reaches the flow. */
function buildResumeContext(runId: RunId): AgentLaunchContext {
  const abortController = new AbortController();
  return {
    setting: { agentCategory: AgentCategory.ToolUse },
    runId,
    session: LANE_SESSION,
    config: { agent: 'test-agent', model: 'test-model' },
    userVarChannels: { MODEL: 'test-model' },
    attachedMemoryMisses: [],
    usageMonitor: { recordUsage: vi.fn() },
    interrupt: () => abortController.abort(),
  } as unknown as AgentLaunchContext;
}

/** A turn that completed with nothing to report. */
function completedTurn() {
  return {
    outcome: RUN_OUTCOME.COMPLETED,
    response: '',
    files: [],
    usage: NO_USAGE,
    structured: undefined,
  };
}

/** Handle stub for tests that only need the flow to run to completion. */
function noopFlowHandle(): unknown {
  return {
    attachToolUseFlow: vi.fn(),
    detachToolUseFlow: vi.fn(),
  };
}

describe('resumeToolUseFromResumeData cancellation handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retrieveSessionResumeData.mockImplementation(
      async (runId, agentConfig) =>
        createToolUseResumeData({ runId, agentConfig }),
    );
    mocks.releaseClaims.mockReturnValue(Effect.void);
    mocks.readView.mockReset().mockResolvedValue(emptySessionView('resume'));
    // Default: the lifecycle wrapper just runs the flow against a no-op
    // handle. Tests that need a real handle override with
    // mockImplementationOnce, which takes precedence for their single call.
    mocks.runFlowWithLifecycle.mockImplementation(
      (
        _context: unknown,
        run: (liveHandle: unknown) => Effect.Effect<unknown, unknown>,
      ) => run(noopFlowHandle()),
    );
  });

  it.effect('resolves run lineage before activating the resume stream', () =>
    Effect.gen(function* () {
      const storageError = new Error('run lineage unavailable');
      const snapshot = createToolUseResumeData({ runId: 'e80481' as RunId });
      mocks.readView.mockRejectedValueOnce(storageError);

      expect(yield* Effect.flip(resumeToolUseFromResumeData(snapshot))).toBe(
        storageError,
      );

      expect(mocks.buildAgentLaunchContext).not.toHaveBeenCalled();
      expect(mocks.releaseClaims).toHaveBeenCalledWith(
        qualifyAggregateId('run', snapshot.runId),
      );
      expect(mocks.releaseClaims).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect(
    'reports a reloaded session that is no longer resumable distinctly',
    () =>
      Effect.gen(function* () {
        const snapshot = createToolUseResumeData({ runId: 'e80482' as RunId });
        mocks.retrieveSessionResumeData.mockResolvedValueOnce(null);

        expect(
          yield* Effect.flip(resumeToolUseFromResumeData(snapshot)),
        ).toBeInstanceOf(ResumeSessionUnavailableError);
        expect(mocks.buildAgentLaunchContext).not.toHaveBeenCalled();
      }),
  );

  it.effect('rejects a resumed launch that is not a tool-use agent', () =>
    Effect.gen(function* () {
      const resume = createToolUseResumeData({ runId: 'e80483' as RunId });
      // The guard runs inside the lifecycle so its failure ends the started
      // stream; the mocked lifecycle only has to run the body.
      mocks.runFlowWithLifecycle.mockImplementationOnce(
        (_context: unknown, runner: (...args: unknown[]) => unknown) =>
          runner({}),
      );
      mocks.buildAgentLaunchContext.mockResolvedValueOnce({
        setting: { agentCategory: AgentCategory.Workflow },
        runId: resume.runId,
        session: {
          releaseRunLease: vi.fn(async () => {}),
        },
      } as unknown as AgentLaunchContext);

      const error = yield* Effect.flip(resumeToolUseFromResumeData(resume));
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(
        'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
      );
    }),
  );

  it.effect(
    'interrupts at flow attachment before substantive work starts',
    () =>
      Effect.gen(function* () {
        const runId = 'e80491' as RunId;
        const context = buildResumeContext(runId);
        const order: string[] = [];
        const tools = [
          {
            definition: { name: 'run_scoped' },
            call: vi.fn(),
          },
        ] as unknown as readonly ITool[];
        let attachedContext: TestFlowContext | undefined;
        const handle = {
          attachToolUseFlow: vi.fn((flowContext: TestFlowContext) => {
            order.push('attach');
            attachedContext = flowContext;
          }),
          detachToolUseFlow: vi.fn((flowContext: TestFlowContext) => {
            order.push('detach');
            if (attachedContext === flowContext) attachedContext = undefined;
          }),
        };

        mocks.buildAgentLaunchContext.mockResolvedValueOnce(context);
        mocks.runFlowWithLifecycle.mockImplementationOnce(
          (
            _context: unknown,
            run: (liveHandle: typeof handle) => Effect.Effect<unknown, unknown>,
          ) => run(handle),
        );
        mocks.runToolUse.mockImplementationOnce(
          (start: InterruptibleLoopStart) =>
            Effect.sync(() => {
              let interrupted = false;
              const flowContext: TestFlowContext = {
                interrupt: () => {
                  order.push('interrupt');
                  interrupted = true;
                },
              };
              start.attachment.attach(flowContext);
              if (!interrupted) mocks.invokeModelOrTool();
              start.attachment.detach(flowContext);
              return {
                outcome: interrupted
                  ? RUN_OUTCOME.CANCELLED
                  : RUN_OUTCOME.COMPLETED,
                response: '',
                files: [],
                usage: NO_USAGE,
                structured: undefined,
              };
            }),
        );

        const snapshot = createToolUseResumeData({ runId });

        const result = yield* resumeToolUseFromResumeData(snapshot, {
          tools,
          isCancellationRequested: () => {
            order.push('query');
            expect(attachedContext).toBeDefined();
            return true;
          },
          onCancellationAtFlowAttachment: () => order.push('cancel'),
        });

        expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
        // The run-scoped tools reach the loop through the run's own layer.
        expect(mocks.agentRunLayer).toHaveBeenCalledWith(
          context,
          expect.objectContaining({ tools }),
        );
        expect(mocks.releaseClaims).toHaveBeenCalledWith(
          qualifyAggregateId('run', runId),
        );
        expect(mocks.invokeModelOrTool).not.toHaveBeenCalled();
        expect(order).toEqual([
          'attach',
          'query',
          'cancel',
          'interrupt',
          'detach',
        ]);
      }),
  );

  it.effect(
    'surfaces a teardown failure after an otherwise successful turn',
    () =>
      Effect.gen(function* () {
        const runId = 'e80501' as RunId;
        const teardownFailure = new Error(
          'final artifacts could not be flushed',
        );
        mocks.buildAgentLaunchContext.mockResolvedValueOnce(
          buildResumeContext(runId),
        );
        mocks.runToolUse.mockImplementationOnce(() =>
          Effect.succeed(completedTurn()),
        );
        settlePublications.mockReturnValueOnce(Effect.fail(teardownFailure));

        // A failed drain rolled back facts the run had queued, so it reaches
        // the caller typed, carrying what threw.
        expect(
          yield* Effect.flip(
            resumeToolUseFromResumeData(createToolUseResumeData({ runId })),
          ),
        ).toMatchObject({
          name: 'RunArtifactDrainError',
          cause: teardownFailure,
        });
      }),
  );

  it.effect('reports the turn failure and the teardown failure together', () =>
    Effect.gen(function* () {
      // The run's own failure is not replaced by the teardown's: both reach
      // the caller, the run's first.
      const runId = 'e80511' as RunId;
      const turnFailure = new Error('turn failed');
      const teardownFailure = new Error('final artifacts could not be flushed');
      mocks.buildAgentLaunchContext.mockResolvedValueOnce(
        buildResumeContext(runId),
      );
      mocks.runToolUse.mockImplementationOnce(() => Effect.fail(turnFailure));
      settlePublications.mockReturnValueOnce(Effect.fail(teardownFailure));

      const error = yield* Effect.flip(
        resumeToolUseFromResumeData(createToolUseResumeData({ runId })),
      );
      expect(error).toSatisfy(
        (value: unknown) =>
          value instanceof AggregateError &&
          value.message.includes('could not be persisted') &&
          value.errors[0] === turnFailure &&
          value.errors[1] instanceof RunArtifactDrainError &&
          value.errors[1].cause === teardownFailure,
      );
    }),
  );

  it.effect(
    'mirrors a mid-run model switch onto the persisted config only',
    () =>
      Effect.gen(function* () {
        const runId = 'e9421d0de1' as RunId;
        const ctx = buildResumeContext(runId);
        mocks.buildAgentLaunchContext.mockResolvedValueOnce(ctx);
        mocks.runToolUse.mockImplementationOnce(() =>
          Effect.sync(() => {
            const callbacks = mocks.agentRunLayer.mock.calls[0]?.[1]
              .callbacks as CapturedRunCallbacks;
            callbacks.onModelChanged('next-model');
            return {
              outcome: RUN_OUTCOME.COMPLETED,
              response: '',
              files: [],
              usage: NO_USAGE,
              structured: undefined,
            };
          }),
        );

        yield* resumeToolUseFromResumeData(createToolUseResumeData({ runId }));

        // The cell is the live model: usage accounting and the prompt-side MODEL
        // variable read it directly, so the only remaining mirror is the
        // persisted AgentConfig schema field; the seeded transient stays as-is.
        expect(ctx.config.model).toBe('next-model');
        expect(ctx.userVarChannels.MODEL).toBe('test-model');
      }),
  );
});
