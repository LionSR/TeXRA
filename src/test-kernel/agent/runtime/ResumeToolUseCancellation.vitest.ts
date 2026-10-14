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
  canResume: vi.fn(),
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

vi.mock('@agent/storage/resumability', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/resumability')>()),
  canResume: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.canResume(...args),
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
import { qualifyAggregateId, type RunId } from '@shared/schemas';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { fakeProcessServices } from '@test/support/setupPlatform';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { ensureError } from '@utils/errors/errorMessage';

/** The session the resume runs on. */
const LANE_SESSION = {
  // The run layer builds the session's rooted filesystems from these.
  roots: createFakeWorkspaceRoots(),
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
    mocks.canResume.mockResolvedValue(true);
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
        mocks.canResume.mockResolvedValueOnce(false);

        expect(
          yield* Effect.flip(resumeToolUseFromResumeData(snapshot)),
        ).toBeInstanceOf(ResumeSessionUnavailableError);
        expect(mocks.buildAgentLaunchContext).not.toHaveBeenCalled();
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
