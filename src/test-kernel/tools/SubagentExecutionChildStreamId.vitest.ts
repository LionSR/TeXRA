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
  currentSession: vi.fn(),
  getCurrentToolCallContext: vi.fn(),
}));

vi.mock('@agent/runtime/childRunLoop', () => ({
  startChildRunLoop: mocks.startChildRunLoop,
}));

vi.mock('@agent/storage', () => ({
  registerExecution: mocks.registerExecution,
}));

vi.mock('@agent/runtime/RunContext', () => {
  const readRunContextField = (context: any, field: string) =>
    context?.kind === 'launch' ? context.runScope[field] : context?.[field];
  return {
    tryUseRunContext: mocks.tryUseRunContext,
    getRunContextExecutionId: (context: any) =>
      readRunContextField(context, 'executionId'),
    getRunContextRuntimeHost: (context: any) =>
      readRunContextField(context, 'runtimeHost'),
  };
});

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.currentSession,
}));

vi.mock('@agent/followUp/ToolFileInteractionContext', () => ({
  getCurrentToolCallContext: mocks.getCurrentToolCallContext,
}));

vi.mock('@tools/approval', () => ({
  enableYoloOnChildStream: vi.fn(),
  inheritBashBypassOnChildStream: vi.fn(),
}));

import { executeSubagent } from '@tools/delegation/subagentExecution';

describe('executeSubagent childStreamId derivation', () => {
  const orchestratorStreamId = 'orchestrator-stream' as StreamTabId;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registerExecution.mockResolvedValue(undefined);
    mocks.tryUseRunContext.mockReturnValue({
      runtimeHost: { emit: vi.fn() },
      executionId: 'parent-exec',
      approvalPromptsUnavailable: false,
      runtimeUnavailableTools: [],
      stopAfterCycle: false,
    });
    mocks.currentSession.mockReturnValue({ tag: 'parent-session' });
    mocks.getCurrentToolCallContext.mockReturnValue(undefined);
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
      'parent-exec',
    );
    const expectedChildStreamId = getStreamTabId(
      configPayload.agent,
      configPayload.model,
      { executionId: loopParams.executionId as never },
    );
    expect(loopParams.childStreamId).toBe(expectedChildStreamId);
    // Confirms the bug the review flagged would have actually mismatched:
    // the OLD (agentName-keyed) formula produces a different id.
    expect(loopParams.childStreamId).not.toBe(
      getStreamTabId(agentName, configPayload.model, {
        executionId: loopParams.executionId as never,
      }),
    );
  });
});
