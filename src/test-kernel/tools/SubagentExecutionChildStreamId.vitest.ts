// Regression coverage for the childStreamId derivation `executeSubagent`
// hands to `startChildRunLoop`: it must match the id `buildAgentLaunchContext`
// actually reserves for the executionId (AgentLaunchContext.ts's
// `reservedStreamId`, computed from the RAW `configPayload.agent`/
// `configPayload.model` — the id that always wins over any later
// recomputation), not a parallel formula keyed off the `agentName` parameter,
// which callers may resolve differently from `configPayload.agent` (e.g. a
// display name vs. the config's own registry name).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getStreamTabId } from '@agent/runtime/streamTab';
import type { StreamTabId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  startChildRunLoop: vi.fn(),
  registerExecution: vi.fn(),
  tryUseRunContext: vi.fn(),
  getCurrentToolCallContext: vi.fn(),
  childLoopError: vi.fn(),
}));

vi.mock('@agent/runtime/childRunLoop', () => ({
  startChildRunLoop: mocks.startChildRunLoop,
}));

vi.mock('@agent/trace', () => ({
  createChannelTrace: () => ({ error: mocks.childLoopError }),
}));

vi.mock('@agent/storage', () => ({
  registerExecution: mocks.registerExecution,
}));

// `executeSubagent` registers through `registerOwnedExecution`, which calls
// `registerExecution` module-internally; route the spy through it the same way.
vi.mock('@agent/storage/executionLifecycle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/storage/executionLifecycle')>();
  return {
    ...actual,
    registerOwnedExecution: async (...args: unknown[]) => {
      await mocks.registerExecution(...args);
      return (operation: () => unknown) => operation();
    },
  };
});

vi.mock('@agent/storage/executionLease', () => ({
  EXECUTION_LEASE_STALE_MS: 120_000,
  captureOwnedExecutionLease:
    (_executionId: string) => (operation: () => unknown) =>
      operation(),
  runWithOwnedExecutionLeaseLaunchGuard: (
    _executionId: string,
    operation: () => unknown,
  ) => operation(),
}));

vi.mock('@agent/runtime/RunContext', () => {
  const readRunContextField = (context: any, field: string) =>
    context?.kind === 'launch' ? context.runScope[field] : context?.[field];
  return {
    tryUseRunContext: mocks.tryUseRunContext,
    getRunContextExecutionId: (context: any) =>
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

  function runDefaultSubagent(): ReturnType<typeof executeSubagent> {
    return executeSubagent(
      defaultPayload,
      'proof-checker',
      orchestratorStreamId,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startChildRunLoop.mockReturnValue({
      completion: Promise.resolve(),
    });
    mocks.registerExecution.mockResolvedValue(undefined);
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

  it('derives childStreamId from configPayload.agent, not the (possibly different) agentName parameter', async () => {
    const configPayload = {
      agent: 'proof-checker', // the config's own registry name
      model: 'gpt5',
      agentCategory: 'toolUse',
      instruction: 'Check the proof.',
    };
    // A caller-resolved display name that intentionally differs from
    // configPayload.agent — this is the exact mismatch the review flagged.
    const agentName = 'Proof Checker (display)';

    await executeSubagent(
      configPayload as never,
      agentName,
      orchestratorStreamId,
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
      loopParams.executionId,
      expect.any(Object),
      agentName,
      expect.objectContaining({
        parentExecutionId: 'parent-exec',
        streamId: loopParams.childStreamId,
      }),
    );
    const expectedChildStreamId = getStreamTabId(configPayload.agent, {
      executionId: loopParams.executionId as never,
    });
    expect(loopParams.childStreamId).toBe(expectedChildStreamId);
    // Confirms the bug the review flagged would have actually mismatched:
    // the OLD (agentName-keyed) formula produces a different id.
    expect(loopParams.childStreamId).not.toBe(
      getStreamTabId(agentName, {
        executionId: loopParams.executionId as never,
      }),
    );
  });

  it('logs a detached run-loop rejection through the runtime trace', async () => {
    const lateFailure = new Error('late subagent finalization failed');
    mocks.startChildRunLoop.mockReturnValue({
      completion: Promise.reject(lateFailure),
    });

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
