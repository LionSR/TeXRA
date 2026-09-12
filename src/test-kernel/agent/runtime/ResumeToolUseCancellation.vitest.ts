// Third-party imports
import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildAgentLaunchContext: vi.fn(),
  readView: vi.fn(),
  invokeModelOrTool: vi.fn(),
  runFlowWithLifecycle: vi.fn(),
  runToolUse: vi.fn(),
  agentRunLayer: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  acquireResumedRunLease: vi.fn(),
  validateOwnedRunLease: vi.fn(),
  runWithRunLeaseWriteFence: vi.fn(
    async (_runId: RunId, operation: () => Promise<unknown>) => operation(),
  ),
  releaseOwnedRunLease: vi.fn(),
  releaseRunClaims: vi.fn(),
}));

vi.mock('@agent/storage/runLease', () => ({
  acquireResumedRunLease: mocks.acquireResumedRunLease,
  assertOwnedRunLease: vi.fn(),
  releaseOwnedRunLease: mocks.releaseOwnedRunLease,
  validateOwnedRunLease: mocks.validateOwnedRunLease,
  runWithRunLeaseWriteFence: mocks.runWithRunLeaseWriteFence,
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
    withLaunchRunContext: (
      _context: unknown,
      _options: unknown,
      run: () => Effect.Effect<unknown, unknown>,
    ) => run(),
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

vi.mock('@agent/runtime/ModelInvoker', async () => ({
  modelInvokerLayer: (await import('effect')).Layer.empty,
}));

vi.mock('@agent/runtime/FollowUps', async () => ({
  followUpsLayer: (await import('effect')).Layer.empty,
}));

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
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { RUN_OUTCOME, type RunId, AgentCategory } from '@shared/schemas';
import { emptySessionView } from '@shared/session/sessionView';
import { fakeProcessServices } from '@test/support/setupPlatform';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { ensureError } from '@utils/errors/errorMessage';

/** The part of `ToolUseStart` this suite drives. */
interface InterruptibleLoopStart {
  takePendingFollowUps?: () => readonly unknown[];
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

/** The artifact flush the lane's lease release drains; a case may fail it. */
const flushArtifacts = vi.fn(async () => {});

/**
 * The session whose run lane admits the resume. No competing generation
 * exists in this fixture, so the lane is a passthrough.
 */
const LANE_SESSION = {
  runs: {
    launchRun: (_runId: RunId, operation: Effect.Effect<unknown, unknown>) =>
      operation,
  },
  acquireClaims: () => Effect.succeed(Effect.void),
  graph: { releaseRunClaims: mocks.releaseRunClaims },
  transcripts: { ensureLoaded: vi.fn(() => Effect.void) },
  // The resumed run reads its parent edge off the session's cold fold, so the
  // lineage fixture is that read.
  readView: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.readView(...args),
      catch: ensureError,
    }),
  status: {},
  flushArtifacts,
  settlePublications: vi.fn(async () => {}),
  releaseRunLease: SessionHandle.prototype.releaseRunLease,
} as never;

function resumeToolUseFromResumeData(
  resume: Parameters<typeof resumeOnLane>[0],
  options: ResumeToolUseFromResumeDataOptions = {},
) {
  return Effect.runPromise(
    Effect.provide(
      resumeOnLane(resume, { session: LANE_SESSION, ...options }),
      fakeProcessServices(),
    ),
  );
}

/** Minimal launch context for a resumed tool-use run that reaches the flow. */
function buildResumeContext(runId: RunId): AgentLaunchContext {
  const abortController = new AbortController();
  return {
    setting: { agentCategory: AgentCategory.ToolUse },
    runScope: {
      runId,
      session: LANE_SESSION,
      signal: abortController.signal,
    },
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
    mocks.acquireResumedRunLease.mockResolvedValue('existing');
    mocks.retrieveSessionResumeData.mockImplementation(
      async (runId, agentConfig) =>
        createToolUseResumeData({ runId, agentConfig }),
    );
    mocks.releaseOwnedRunLease.mockResolvedValue(undefined);
    mocks.releaseRunClaims.mockReturnValue(Effect.void);
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

  it('resolves run lineage before activating the resume stream', async () => {
    const storageError = new Error('run lineage unavailable');
    const snapshot = createToolUseResumeData({ runId: 'e80481' as RunId });
    mocks.readView.mockRejectedValueOnce(storageError);

    await expect(resumeToolUseFromResumeData(snapshot)).rejects.toBe(
      storageError,
    );

    expect(mocks.buildAgentLaunchContext).not.toHaveBeenCalled();
    expect(mocks.releaseOwnedRunLease).toHaveBeenCalledWith(snapshot.runId);
    expect(mocks.releaseRunClaims).toHaveBeenCalledWith(snapshot.runId);
    expect(mocks.releaseRunClaims).toHaveBeenCalledTimes(1);
  });

  it('reports a reloaded session that is no longer resumable distinctly', async () => {
    const snapshot = createToolUseResumeData({ runId: 'e80482' as RunId });
    mocks.retrieveSessionResumeData.mockResolvedValueOnce(null);

    await expect(resumeToolUseFromResumeData(snapshot)).rejects.toBeInstanceOf(
      ResumeSessionUnavailableError,
    );
    expect(mocks.buildAgentLaunchContext).not.toHaveBeenCalled();
  });

  it('rejects a resumed launch that is not a tool-use agent', async () => {
    const resume = createToolUseResumeData({ runId: 'e80483' as RunId });
    // The guard runs inside the lifecycle so its failure ends the started
    // stream; the mocked lifecycle only has to run the body.
    mocks.runFlowWithLifecycle.mockImplementationOnce(
      (_context: unknown, runner: (...args: unknown[]) => unknown) =>
        runner({}),
    );
    mocks.buildAgentLaunchContext.mockResolvedValueOnce({
      setting: { agentCategory: AgentCategory.Workflow },
      runScope: {
        runId: resume.runId,
        session: {
          flushArtifacts: vi.fn(),
          releaseRunLease: vi.fn(async () => {}),
        },
      },
    } as unknown as AgentLaunchContext);

    await expect(resumeToolUseFromResumeData(resume)).rejects.toThrow(
      'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
    );
  });

  it('interrupts at flow attachment before substantive work starts', async () => {
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
    mocks.runToolUse.mockImplementationOnce((start: InterruptibleLoopStart) =>
      Effect.sync(() => {
        let interrupted = false;
        const flowContext: TestFlowContext = {
          interrupt: () => {
            order.push('interrupt');
            interrupted = true;
          },
        };
        start.attachment.attach(flowContext);
        start.takePendingFollowUps?.();
        if (!interrupted) mocks.invokeModelOrTool();
        start.attachment.detach(flowContext);
        return {
          outcome: interrupted ? RUN_OUTCOME.CANCELLED : RUN_OUTCOME.COMPLETED,
          response: '',
          files: [],
          usage: NO_USAGE,
          structured: undefined,
        };
      }),
    );

    const snapshot = createToolUseResumeData({ runId });

    const result = await resumeToolUseFromResumeData(snapshot, {
      tools,
      takePendingFollowUps: () => {
        order.push('take');
        return [];
      },
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
    expect(mocks.releaseOwnedRunLease).toHaveBeenCalledWith(runId);
    expect(mocks.invokeModelOrTool).not.toHaveBeenCalled();
    expect(order).toEqual([
      'attach',
      'query',
      'cancel',
      'interrupt',
      'take',
      'detach',
    ]);
  });

  it('surfaces a teardown failure after an otherwise successful turn', async () => {
    const runId = 'e80501' as RunId;
    const teardownFailure = new Error('final artifacts could not be flushed');
    mocks.buildAgentLaunchContext.mockResolvedValueOnce(
      buildResumeContext(runId),
    );
    mocks.runToolUse.mockImplementationOnce(() =>
      Effect.succeed(completedTurn()),
    );
    flushArtifacts.mockRejectedValueOnce(teardownFailure);

    await expect(
      resumeToolUseFromResumeData(createToolUseResumeData({ runId })),
    ).rejects.toBe(teardownFailure);
  });

  it('reports the turn failure and the teardown failure together', async () => {
    // The run's own failure is not replaced by the teardown's: both reach
    // the caller, the run's first.
    const runId = 'e80511' as RunId;
    const turnFailure = new Error('turn failed');
    const teardownFailure = new Error('final artifacts could not be flushed');
    mocks.buildAgentLaunchContext.mockResolvedValueOnce(
      buildResumeContext(runId),
    );
    mocks.runToolUse.mockImplementationOnce(() => Effect.fail(turnFailure));
    flushArtifacts.mockRejectedValueOnce(teardownFailure);

    await expect(
      resumeToolUseFromResumeData(createToolUseResumeData({ runId })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        error.message.includes('could not be persisted') &&
        error.errors[0] === turnFailure &&
        error.errors[1] === teardownFailure,
    );
  });

  it('mirrors a mid-run model switch onto the persisted config only', async () => {
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

    await resumeToolUseFromResumeData(createToolUseResumeData({ runId }));

    // The cell is the live model: usage accounting and the prompt-side MODEL
    // variable read it directly, so the only remaining mirror is the
    // persisted AgentConfig schema field; the seeded transient stays as-is.
    expect(ctx.config.model).toBe('next-model');
    expect(ctx.userVarChannels.MODEL).toBe('test-model');
  });
});
