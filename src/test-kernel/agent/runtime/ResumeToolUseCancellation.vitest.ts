// Third-party imports
import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildAgentLaunchContext: vi.fn(),
  getPersistedUserFollowUpSupport: vi.fn(),
  hasPersistedParent: vi.fn(),
  invokeModelOrTool: vi.fn(),
  runFlowWithLifecycle: vi.fn(),
  runToolUseFlow: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  acquireResumedRunLease: vi.fn(),
  validateOwnedRunLease: vi.fn(),
  runWithRunLeaseWriteFence: vi.fn(
    async (_runId: RunId, operation: () => Promise<unknown>) =>
      operation(),
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

vi.mock('@agent/runtime/AgentRunLifecycle', () => ({
  runFlowWithLifecycle: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.runFlowWithLifecycle(...args),
      catch: ensureError,
    }),
}));

vi.mock('@agent/storage/runLifecycle', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/runLifecycle')>()),
  getPersistedUserFollowUpSupport: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.getPersistedUserFollowUpSupport(...args),
      catch: ensureError,
    }),
  hasPersistedParent: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.hasPersistedParent(...args),
      catch: ensureError,
    }),
}));

vi.mock('@agent/implementations/flows/reflection/runReflectionFlow', () => ({
  runReflectionFlow: vi.fn(),
}));

vi.mock('@agent/implementations/flows/tooluse/runToolUseFlow', () => ({
  runToolUseFlow: mocks.runToolUseFlow,
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
import {
  RUN_OUTCOME,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
  type RunId,
  AgentCategory,
} from '@shared/schemas';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { ensureError } from '@utils/errors/errorMessage';

interface InterruptibleFlowInput {
  readonly runScope: { readonly signal: AbortSignal };
  interrupt(): void;
  takePendingFollowUps?: () => readonly unknown[];
  tools?: readonly ITool[];
}

interface TestFlowContext {
  interrupt(): void;
}

interface ModelSwitchingFlowInput {
  onModelChanged: (model: string) => void;
}

/**
 * The session whose run lane admits the resume. No competing generation
 * exists in this fixture, so the lane is a passthrough.
 */
const LANE_SESSION = {
  executions: {
    launchRun: (
      _runId: RunId,
      operation: Effect.Effect<unknown, unknown>,
    ) => operation,
  },
  acquireRunClaims: () => Effect.succeed(Effect.void),
  graph: { releaseRunClaims: mocks.releaseRunClaims },
  transcripts: { ensureLoaded: vi.fn(() => Effect.void) },
  status: {},
  flushArtifacts: vi.fn(async () => {}),
  settlePublications: vi.fn(async () => {}),
  releaseRunLease: SessionHandle.prototype.releaseRunLease,
} as never;

function resumeToolUseFromResumeData(
  resume: Parameters<typeof resumeOnLane>[0],
  options: ResumeToolUseFromResumeDataOptions = {},
) {
  return Effect.runPromise(
    resumeOnLane(resume, { session: LANE_SESSION, ...options }),
  );
}

/** Minimal launch context for a resumed tool-use run that reaches the flow. */
function buildResumeContext(
  runId: RunId,
  runId: RunId,
): AgentLaunchContext {
  const abortController = new AbortController();
  return {
    setting: { agentCategory: AgentCategory.ToolUse },
    runScope: {
      runId,
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
      async (runId, runId, agentConfig) =>
        createToolUseResumeData({ runId, runId, agentConfig }),
    );
    mocks.getPersistedUserFollowUpSupport.mockResolvedValue(
      USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    );
    mocks.releaseOwnedRunLease.mockResolvedValue(undefined);
    mocks.releaseRunClaims.mockReturnValue(Effect.void);
    // Default: the lifecycle wrapper just runs the flow against a no-op
    // handle. Tests that need a real handle override with
    // mockImplementationOnce, which takes precedence for their single call.
    mocks.runFlowWithLifecycle.mockImplementation(
      async (
        _context: unknown,
        run: (liveHandle: unknown) => Promise<unknown>,
      ) => run(noopFlowHandle()),
    );
  });

  it('preserves persisted native follow-up support across resumed waiting turns', async () => {
    const runId = 'e9911-native-resume' as RunId;
    const runId = 'stream-9911-native-resume' as RunId;
    const snapshot = createToolUseResumeData({ runId, runId });
    mocks.getPersistedUserFollowUpSupport.mockResolvedValue(
      USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
    );
    mocks.hasPersistedParent.mockResolvedValue(true);
    mocks.buildAgentLaunchContext
      .mockResolvedValueOnce(buildResumeContext(runId, runId))
      .mockResolvedValueOnce(buildResumeContext(runId, runId));
    mocks.runToolUseFlow.mockResolvedValue({
      outcome: 'waiting',
      response: 'ready for another follow-up',
    });

    await resumeToolUseFromResumeData(snapshot);
    await resumeToolUseFromResumeData(snapshot);

    // The persisted support rides the launch input: `run.start` stamps it at
    // the reservation commit point, before the lifecycle runs.
    expect(mocks.buildAgentLaunchContext).toHaveBeenCalledTimes(2);
    expect(
      mocks.buildAgentLaunchContext.mock.calls.map(
        (call) => call[0]?.userFollowUpSupport,
      ),
    ).toEqual([
      USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
    ]);
  });

  it('resolves run lineage before activating the resume stream', async () => {
    const storageError = new Error('run metadata unavailable');
    const snapshot = createToolUseResumeData({
      runId: 'e8048' as RunId,
      runId: 'stream-8048' as RunId,
    });
    mocks.hasPersistedParent.mockRejectedValueOnce(storageError);

    await expect(resumeToolUseFromResumeData(snapshot)).rejects.toBe(
      storageError,
    );

    expect(mocks.buildAgentLaunchContext).not.toHaveBeenCalled();
    expect(mocks.releaseOwnedRunLease).toHaveBeenCalledWith(
      snapshot.runId,
    );
    expect(mocks.releaseRunClaims).toHaveBeenCalledWith(
      snapshot.runId,
    );
    expect(mocks.releaseRunClaims).toHaveBeenCalledTimes(1);
  });

  it('reports a reloaded session that is no longer resumable distinctly', async () => {
    const snapshot = createToolUseResumeData();
    mocks.retrieveSessionResumeData.mockResolvedValueOnce(null);

    await expect(resumeToolUseFromResumeData(snapshot)).rejects.toBeInstanceOf(
      ResumeSessionUnavailableError,
    );
    expect(mocks.buildAgentLaunchContext).not.toHaveBeenCalled();
  });

  it('rejects a resumed launch that is not a tool-use agent', async () => {
    const resume = createToolUseResumeData();
    mocks.hasPersistedParent.mockResolvedValueOnce(false);
    // The guard runs inside the lifecycle so its failure ends the started
    // stream; the mocked lifecycle only has to run the body.
    mocks.runFlowWithLifecycle.mockImplementationOnce(
      (_context: unknown, runner: (...args: unknown[]) => unknown) =>
        runner({}, {}),
    );
    mocks.buildAgentLaunchContext.mockResolvedValueOnce({
      setting: { agentCategory: AgentCategory.Workflow },
      runScope: {
        runId: resume.runId,
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
    const runId = 'e8049' as RunId;
    const runId = 'stream-8049' as RunId;
    const context = buildResumeContext(runId, runId);
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
    mocks.hasPersistedParent.mockResolvedValueOnce(false);
    mocks.runFlowWithLifecycle.mockImplementationOnce(
      async (
        _context: unknown,
        run: (liveHandle: typeof handle) => Promise<unknown>,
      ) => run(handle),
    );
    mocks.runToolUseFlow.mockImplementationOnce(
      async (
        input: InterruptibleFlowInput,
        _registry: unknown,
        attachment: {
          attach: (flowContext: TestFlowContext) => void;
          detach: (flowContext: TestFlowContext) => void;
        },
      ) => {
        expect(input.tools).toBe(tools);
        const flowContext: TestFlowContext = {
          interrupt: () => {
            order.push('interrupt');
            input.interrupt();
          },
        };
        attachment.attach(flowContext);
        input.takePendingFollowUps?.();
        if (!input.runScope.signal.aborted) mocks.invokeModelOrTool();
        attachment.detach(flowContext);
        return {
          outcome: input.runScope.signal.aborted
            ? RUN_OUTCOME.CANCELLED
            : RUN_OUTCOME.COMPLETED,
        };
      },
    );

    const snapshot = createToolUseResumeData({
      runId,
      runId,
    });

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

  it('mirrors a mid-run model switch onto the persisted config only', async () => {
    const runId = 'e9421-model' as RunId;
    const runId = 'stream-9421-model' as RunId;
    const ctx = buildResumeContext(runId, runId);
    mocks.buildAgentLaunchContext.mockResolvedValueOnce(ctx);
    mocks.hasPersistedParent.mockResolvedValueOnce(false);
    mocks.runToolUseFlow.mockImplementationOnce(
      async (input: ModelSwitchingFlowInput) => {
        input.onModelChanged('next-model');
        return { outcome: RUN_OUTCOME.COMPLETED };
      },
    );

    await resumeToolUseFromResumeData(
      createToolUseResumeData({ runId, runId }),
    );

    // The cell is the live model: usage accounting and the prompt-side MODEL
    // variable read it directly, so the only remaining mirror is the
    // persisted AgentConfig schema field; the seeded transient stays as-is.
    expect(ctx.config.model).toBe('next-model');
    expect(ctx.userVarChannels.MODEL).toBe('test-model');
  });

  it('carries a failed resumed flow result, error included, to the lifecycle', async () => {
    const runId = 'e9421-error' as RunId;
    const runId = 'stream-9421-error' as RunId;
    const flowError = {
      message: 'provider failed mid-resume',
      userRetryable: true,
    };
    mocks.buildAgentLaunchContext.mockResolvedValueOnce(
      buildResumeContext(runId, runId),
    );
    mocks.hasPersistedParent.mockResolvedValueOnce(true);
    mocks.runToolUseFlow.mockResolvedValueOnce({
      outcome: RUN_OUTCOME.FAILED,
      response: 'partial answer',
      totalCostUsd: 0.25,
      error: flowError,
    });

    const result = await resumeToolUseFromResumeData(
      createToolUseResumeData({ runId, runId }),
    );

    expect(result).toMatchObject({
      category: 'toolUse',
      outcome: RUN_OUTCOME.FAILED,
      response: 'partial answer',
      totalCostUsd: 0.25,
      runId,
      runId,
      error: flowError,
    });
  });
});
