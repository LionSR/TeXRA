// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildAgentLaunchContext: vi.fn(),
  readRunRecords: vi.fn(),
  runWithLifecycle: vi.fn(),
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
  runWithLifecycle: (...args: unknown[]) => mocks.runWithLifecycle(...args),
}));

// The launch terminal's backstop row: the lifecycle this suite stubs owns
// the run's ending, so the backstop keeps it.
vi.mock('@agent/storage/runLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/runLifecycle')>()),
  finalizeRun: () => Effect.succeed({ ok: true, outcome: 'completed' }),
}));

vi.mock('@agent/runtime/loop/toolUse', () => ({
  runToolUse: mocks.runToolUse,
}));

// The per-run services the lane provides are built and exercised by the loop
// suites. Here only the layer's *input* matters: the tools the lane hands the
// run and the callbacks it wires, so the layer carries only the composition
// the launch reads back for its result, and its input is captured.
vi.mock('@agent/runtime/run/AgentRun', async (importOriginal) => {
  const { Layer } = await import('effect');
  const actual =
    await importOriginal<typeof import('@agent/runtime/run/AgentRun')>();
  return {
    ...actual,
    agentRunLayer: (...args: unknown[]) => {
      mocks.agentRunLayer(...args);
      return Layer.succeed(actual.AgentRun)({
        composition: { key: { hash: 'test-composition' } },
      } as never);
    },
  };
});

vi.mock('@agent/runtime/ModelInvoker', async () => {
  const { Layer } = await import('effect');
  return { modelInvokerLayer: () => Layer.empty };
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
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  type RunId,
} from '@shared/schemas';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { fakeProcessServices } from '@test/support/setupPlatform';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { ensureError } from '@utils/errors/errorMessage';

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
};

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
  },
  log: {
    // The resume's hold on the run's claim: its release is what the suite
    // observes, when the resume's scope closes.
    hold: (runId: RunId) =>
      Effect.asVoid(
        Effect.acquireRelease(Effect.void, () =>
          Effect.suspend(() =>
            mocks.releaseClaims(qualifyAggregateId('run', runId)),
          ),
        ),
      ),
    rows: () => Effect.succeed([]),
    // The launch guard reads whether the run exists, and the resumed run
    // its parent edge, off the run's records, so the fixture is that read.
    records: (...args: unknown[]) =>
      Effect.tryPromise({
        try: () => mocks.readRunRecords(...args),
        catch: ensureError,
      }),
  },
  status: {},
  // A surface that can present approval prompts.
  interactions: { approvalPromptsUnavailable: false },
} as never;

function resumeToolUseFromResumeData(
  resume: Parameters<typeof resumeOnLane>[0],
  options: Partial<ResumeToolUseFromResumeDataOptions> = {},
) {
  return Effect.provide(
    resumeOnLane(resume, { session: LANE_SESSION, ...options }),
    fakeProcessServices(),
  );
}

/** Minimal launch context for a resumed tool-use run that reaches the flow. */
function buildResumeContext(runId: RunId): AgentLaunchContext {
  return {
    persona: { prompt: '', tools: [], temperature: 1 },
    task: null,
    runId,
    session: LANE_SESSION,
    config: { agent: 'test-agent', model: 'test-model' },
    opening: {
      inputs: {},
      catalog: [],
      activated: [],
      attachedMemoryMisses: [],
    },
    attachedMemoryMisses: [],
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
    memoryMisses: [],
  };
}

/** Handle stub for tests that only need the flow to run to completion. */
function noopRunHandle(): unknown {
  return {
    attachControls: vi.fn(),
    detachControls: vi.fn(),
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
    // A resume's run exists: its stored `run.start`, a root's.
    mocks.readRunRecords
      .mockReset()
      .mockImplementation(async (runId: RunId) => [
        { type: 'run.start', aggregateId: qualifyAggregateId('run', runId) },
      ]);
    // Default: the lifecycle wrapper just runs the flow against a no-op
    // handle. Tests that need a real handle override with
    // mockImplementationOnce, which takes precedence for their single call.
    mocks.runWithLifecycle.mockImplementation(
      (
        _context: unknown,
        run: (liveHandle: unknown) => Effect.Effect<unknown, unknown>,
      ) => run(noopRunHandle()),
    );
  });

  it.effect('resolves run lineage before activating the resume stream', () =>
    Effect.gen(function* () {
      const storageError = new Error('run lineage unavailable');
      const snapshot = createToolUseResumeData({ runId: 'e80481' as RunId });
      // The guard's existence read passes; the lineage read fails.
      mocks.readRunRecords
        .mockResolvedValueOnce([
          {
            type: 'run.start',
            aggregateId: qualifyAggregateId('run', snapshot.runId),
          },
        ])
        .mockRejectedValueOnce(storageError);

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

  it.effect(
    'withholds approval-gated tools on a resume when the session surface cannot present prompts',
    () =>
      Effect.gen(function* () {
        // An automatic resume passes no approval option: the fact is the
        // session's, as an embedder with no approval channel declares it.
        const runId = 'e80490' as RunId;
        mocks.buildAgentLaunchContext.mockResolvedValueOnce(
          buildResumeContext(runId),
        );
        mocks.runToolUse.mockReturnValueOnce(Effect.succeed(completedTurn()));
        yield* Effect.provide(
          resumeOnLane(createToolUseResumeData({ runId }), {
            session: {
              ...(LANE_SESSION as object),
              interactions: { approvalPromptsUnavailable: true },
            } as never,
          }),
          fakeProcessServices(),
        ).pipe(Effect.ignore);
        expect(mocks.buildAgentLaunchContext).toHaveBeenCalledWith(
          expect.objectContaining({
            toolPolicy: { approvalPromptsUnavailable: true },
          }),
        );
      }),
  );

  it.effect(
    'a stop asked before the resumed loop starts interrupts the run first',
    () =>
      Effect.gen(function* () {
        const runId = 'e80491' as RunId;
        const context = buildResumeContext(runId);
        const tools = [
          {
            definition: { name: 'run_scoped' },
            call: vi.fn(),
          },
        ] as unknown as readonly ITool[];
        mocks.buildAgentLaunchContext.mockResolvedValueOnce(context);

        const exit = yield* Effect.exit(
          resumeToolUseFromResumeData(createToolUseResumeData({ runId }), {
            tools,
            isCancellationRequested: () => true,
          }),
        );

        // The run's own fiber is interrupted: no loop, so nothing to attach.
        expect(Exit.hasInterrupts(exit)).toBe(true);
        expect(mocks.runToolUse).not.toHaveBeenCalled();
        // The run-scoped tools reach the loop through the run's own layer.
        expect(mocks.agentRunLayer).toHaveBeenCalledWith(
          context,
          expect.objectContaining({ tools }),
        );
        expect(mocks.releaseClaims).toHaveBeenCalledWith(
          qualifyAggregateId('run', runId),
        );
      }),
  );
});
