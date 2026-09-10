// Regression coverage for the childStreamId derivation `executeSubagent`
// hands to `startChildRunLoop`: it must match the id `buildAgentLaunchContext`
// actually reserves for the executionId (AgentLaunchContext.ts's
// `reservedStreamId`, computed from the RAW `configPayload.agent`/
// `configPayload.model` — the id that always wins over any later
// recomputation), not a parallel formula keyed off the `agentName` parameter,
// which callers may resolve differently from `configPayload.agent` (e.g. a
// display name vs. the config's own registry name).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import type { StreamTabId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  startChildRunLoop: vi.fn(),
  registerExecution: vi.fn(),
  tryUseRunContext: vi.fn(),
  getCurrentToolCallContext: vi.fn(),
  childLoopError: vi.fn(),
}));

vi.mock('@agent/runtime/AgentLaunchContext', () => ({
  prepareAgentDefinition: ({ config }: { config: unknown }) =>
    Effect.succeed({ config }),
}));

vi.mock('@agent/runtime/childRunLoop', () => ({
  startChildRunLoop: mocks.startChildRunLoop,
  runWithOwnedRunLeaseLaunchGuard: (
    ...args: Parameters<
      typeof import('@agent/runtime/childRunLoop').runWithOwnedRunLeaseLaunchGuard
    >
  ) => args[2],
}));

// `executeSubagent` reports a late detached-loop failure through an inline
// `createLog('childRunLoop')` call; spread the real module so the graph's
// other `createLog` consumers (e.g. `executionLifecycle`,
// `inBandSubagentExecution`) keep working loggers.
vi.mock('@logger/logUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@logger/logUtils')>();
  return {
    ...actual,
    createLog: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: mocks.childLoopError,
    }),
  };
});

vi.mock('@agent/storage', () => ({
  registerRun: mocks.registerExecution,
}));

// `executeSubagent` registers through `registerExecution`; route the spy through it.
vi.mock('@agent/storage/executionLifecycle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/storage/executionLifecycle')>();
  return {
    ...actual,
    registerRun: mocks.registerExecution,
  };
});

vi.mock('@agent/storage/executionLease', () => ({
  assertOwnedRunLease: vi.fn(),
}));

vi.mock('@agent/runtime/RunContext', () => {
  const readRunContextField = (context: any, field: string) =>
    context?.kind === 'launch' ? context.runScope[field] : context?.[field];
  return {
    tryUseRunContext: mocks.tryUseRunContext,
    runInSession: (_session: unknown, operation: () => unknown) => operation(),
    getRunContextRunId: (context: any) =>
      readRunContextField(context, 'executionId'),
    getRunContextSession: (context: any) =>
      readRunContextField(context, 'session'),
  };
});

vi.mock('@agent/followUp/ToolFileInteractionContext', () => ({
  getCurrentToolCallContext: mocks.getCurrentToolCallContext,
}));

vi.mock('@tools/approval', () => ({
  configureDelegatedChildApprovals: vi.fn(),
}));

import { executeSubagent } from '@tools/delegation/subagentExecution';

describe('executeSubagent childStreamId derivation', () => {
  const orchestratorStreamId = 'orchestrator-stream' as StreamTabId;

  const defaultPayload = {
    agent: 'proof-checker',
    model: 'gpt5',
    agentCategory: 'toolUse',
  } as never;

  function runDefaultSubagent() {
    return Effect.runPromise(
      executeSubagent(
        mocks.tryUseRunContext(),
        mocks.getCurrentToolCallContext(),
        defaultPayload,
        'proof-checker',
        orchestratorStreamId,
      ),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startChildRunLoop.mockReturnValue(Effect.forkDetach(Effect.void));
    mocks.registerExecution.mockReturnValue(Effect.void);
    mocks.tryUseRunContext.mockReturnValue({
      executionId: 'parent-exec',
      session: { tag: 'parent-session' },
      approvalPromptsUnavailable: false,
      runtimeUnavailableTools: [],
      stopAfterCycle: false,
    });
    mocks.getCurrentToolCallContext.mockReturnValue(undefined);
  });

  it('requires the run context to carry its owning session', async () => {
    mocks.tryUseRunContext.mockReturnValue({
      executionId: 'parent-exec',
      approvalPromptsUnavailable: false,
      runtimeUnavailableTools: [],
      stopAfterCycle: false,
    });

    await expect(runDefaultSubagent()).resolves.toMatchObject({
      status: 'error',
      summary: 'Delegation session unavailable',
      diagnostics: { type: 'missing_session' },
    });
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('addresses the child stream by its run id, whatever agentName the caller resolved', async () => {
    const configPayload = {
      agent: 'proof-checker', // the config's own registry name
      model: 'gpt5',
      agentCategory: 'toolUse',
      instruction: 'Check the proof.',
    };
    // A caller-resolved display name that intentionally differs from
    // configPayload.agent — this is the exact mismatch the review flagged.
    const agentName = 'Proof Checker (display)';

    await Effect.runPromise(
      executeSubagent(
        mocks.tryUseRunContext(),
        mocks.getCurrentToolCallContext(),
        configPayload as never,
        agentName,
        orchestratorStreamId,
      ),
    );

    expect(mocks.startChildRunLoop).toHaveBeenCalledTimes(1);
    const [loopParams] = mocks.startChildRunLoop.mock.calls[0] as [
      {
        childStreamId: StreamTabId;
        executionId: string;
        parentStreamId: StreamTabId;
      },
    ];
    expect(loopParams.parentStreamId).toBe(orchestratorStreamId);
    expect(mocks.registerExecution).toHaveBeenCalledWith(
      mocks.tryUseRunContext().session,
      loopParams.executionId,
      expect.any(Object),
      agentName,
      expect.objectContaining({
        parentExecutionId: 'parent-exec',
        streamId: loopParams.childStreamId,
      }),
    );
    expect(loopParams.childStreamId).toBe(loopParams.executionId);
  });

  it('logs a detached run-loop rejection through the childRunLoop channel log', async () => {
    const lateFailure = new Error('late subagent finalization failed');
    mocks.startChildRunLoop.mockReturnValue(
      Effect.forkDetach(Effect.fail(lateFailure)),
    );

    await expect(runDefaultSubagent()).resolves.toMatchObject({
      status: 'executed',
    });
    await vi.waitFor(() => {
      expect(mocks.childLoopError).toHaveBeenCalledWith(
        "Subagent 'proof-checker' run loop failed after launch",
        { data: lateFailure },
      );
    });
  });
});
