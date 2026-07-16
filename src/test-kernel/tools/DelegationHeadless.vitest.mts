// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import { AgentFlowError } from '@agent/runtime/AgentFlowResult';
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import {
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { DelegateAgentTool } from '@tools/DelegationTools';
import {
  executeSubagentInBand,
  executeStableSubagentInBand,
  SubagentDurabilityError,
  SubagentReconciliationError,
} from '@tools/delegation/inBandSubagentExecution';

const mocks = vi.hoisted(() => ({
  enableYoloOnChildStream: vi.fn(),
  inheritBashBypassOnChildStream: vi.fn(),
  executeAgent: vi.fn(),
  getExecutionStore: vi.fn(),
  getVisibleAgent: vi.fn(),
  getVisibleAgents: vi.fn(),
  isApprovalBypassedForStream: vi.fn(),
  isProposalBypassed: vi.fn(),
  registerExecution: vi.fn(),
  writeReport: vi.fn(),
  writeResultMeta: vi.fn(),
  computeModelOptionsData: vi.fn(),
}));

vi.mock('@agent/index/agentRegistry', () => ({
  getVisibleAgent: mocks.getVisibleAgent,
  getVisibleAgents: mocks.getVisibleAgents,
}));

vi.mock('@agent/runtime/executeAgent', () => ({
  executeAgent: mocks.executeAgent,
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: mocks.getExecutionStore,
  registerExecution: mocks.registerExecution,
}));

vi.mock('@model/computeModelOptions', () => ({
  computeModelOptionsData: mocks.computeModelOptionsData,
}));

vi.mock('@tools/approval', () => ({
  enableYoloOnChildStream: mocks.enableYoloOnChildStream,
  inheritBashBypassOnChildStream: mocks.inheritBashBypassOnChildStream,
  isApprovalBypassedForStream: mocks.isApprovalBypassedForStream,
  proposalApprovals: () => ({
    isBypassed: mocks.isProposalBypassed,
  }),
}));

function runtimeHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
    interactions: {
      cancel: vi.fn(),
    } satisfies HostInteractions,
  };
}

/** Real session whose interactions slot is the host's fake port. */
function sessionFor(host: AgentRuntimeHost): SessionHandle {
  const session = createTestSession();
  if (host.interactions) session.useHostInteractions(host.interactions);
  return session;
}

/** The shared delegation call used by nearly every case (agent name varies). */
function callDelegateReview(agent = 'review') {
  return new DelegateAgentTool().call({
    agent,
    model: null,
    instruction: 'Check the proof.',
    memories: [],
    working_directory: null,
    execution_id: null,
  });
}

/**
 * One-shot executeAgent mock that reports a failed child via onRunError and
 * returns the same failed result, carrying the given subagent cost.
 */
function mockExecuteAgentErrorOnce(totalCostUsd: number): void {
  mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
    const failed = {
      category: 'toolUse',
      outcome: 'failed',
      executionId: 'child-exec',
      streamId: 'child-stream',
      totalCostUsd,
    };
    await options.onRunError?.(new Error('review model failed'), failed);
    return failed;
  });
}

const STABLE_PARENT_EXECUTION_ID = 'abcdef123456' as ExecutionId;

function stableAttempt(
  logicalExecutionId: ExecutionId,
  phase: 'reserved' | 'launched' | 'retryable' = 'launched',
) {
  return {
    schemaVersion: 1,
    logicalExecutionId,
    parentExecutionId: STABLE_PARENT_EXECUTION_ID,
    phase,
  } as const;
}

function stableSequenceStore(logicalExecutionId: ExecutionId, nextAttempt = 0) {
  let sequence =
    nextAttempt === 0
      ? undefined
      : {
          schemaVersion: 1 as const,
          logicalExecutionId,
          parentExecutionId: STABLE_PARENT_EXECUTION_ID,
          nextAttempt,
        };
  return {
    read: vi.fn(async () => sequence),
    write: vi.fn(async (_key: string, value: typeof sequence) => {
      sequence = value;
    }),
  };
}

describe('headless delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVisibleAgents.mockReturnValue([
      {
        name: 'review',
        description: 'Review work.',
        tools: [],
      },
    ]);
    mocks.getVisibleAgent.mockImplementation(
      (_category: AgentCategory, name: string) =>
        name === 'review'
          ? { name: 'review', source: 'builtInToolUse' }
          : undefined,
    );
    mocks.computeModelOptionsData.mockResolvedValue([
      {
        value: 'deepseekT',
        label: 'DeepSeek',
        disabled: false,
        requiresKey: false,
      },
    ]);
    mocks.isProposalBypassed.mockReturnValue(true);
    mocks.isApprovalBypassedForStream.mockReturnValue(false);
    mocks.registerExecution.mockResolvedValue(undefined);
    mocks.writeReport.mockResolvedValue(undefined);
    mocks.writeResultMeta.mockResolvedValue(undefined);
    mocks.getExecutionStore.mockReturnValue({
      writeReport: mocks.writeReport,
      writeResultMeta: mocks.writeResultMeta,
    });
    mocks.executeAgent.mockResolvedValue({
      category: 'toolUse',
      outcome: 'completed',
      executionId: 'child-exec',
      streamId: 'child-stream',
      lastResponse: 'The proof is correct.',
      touchedFiles: [],
    });
  });

  afterEach(() => {
    for (const executionId of defaultSession().executions.getActiveIds()) {
      defaultSession().executions.untrack(executionId);
    }
    defaultSession().followUps.release('parent-stream' as StreamTabId);
    defaultSession().followUps.release('child-stream' as StreamTabId);
  });

  it('awaits child delegation during one-shot tool-use runs', async () => {
    const result = await withRunContext(
      createRunContext({
        runtimeHost: runtimeHost(),
        streamId: 'parent-stream',
        executionId: 'parent-exec',
        model: 'deepseekT',
        stopAfterCycle: true,
      }),
      () => callDelegateReview(),
    );

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'review',
        agentCategory: AgentCategory.ToolUse,
        instruction: expect.stringContaining('Check the proof.'),
        model: 'deepseekT',
      }),
      expect.any(String),
      expect.objectContaining({
        isSubagent: true,
        parentStreamId: 'parent-stream',
        session: expect.any(Object),
        stopAfterCycle: true,
      }),
    );
    expect(result.summary).toBe("Completed 'review'");
    expect(result.output).toContain('<subagent-result');
    expect(result.output).toContain('<response>');
    expect(result.output).toContain('The proof is correct.');
    expect(mocks.writeReport).toHaveBeenCalledWith(result.output);
  });

  it('returns and persists the typed final result for in-band consumers', async () => {
    const result = await executeSubagentInBand({
      configPayload: {
        agent: 'review',
        agentCategory: AgentCategory.ToolUse,
        model: 'deepseekT',
      },
      agentName: 'review',
      parentExecutionId: 'parent-exec' as ExecutionId,
      parentStreamId: 'parent-stream' as StreamTabId,
      runtimeHost: runtimeHost(),
      session: defaultSession(),
    });

    expect(result.result).toEqual({
      category: 'toolUse',
      outcome: 'completed',
      response: 'The proof is correct.',
      files: [],
      cost: 0,
    });
    expect(mocks.writeReport).not.toHaveBeenCalled();
    expect(mocks.registerExecution).toHaveBeenCalledWith(
      result.executionId,
      expect.objectContaining({ agent: 'review' }),
      'review',
      'parent-exec',
    );
    expect(mocks.writeResultMeta).toHaveBeenCalledWith({
      producer: 'subagent',
      agentName: 'review',
      parentExecutionId: 'parent-exec',
      wallTimeMs: expect.any(Number),
      result: result.result,
    });
  });

  it('recovers a completed stable child before resolving launch prerequisites', async () => {
    const stableExecutionId = 'cccccc333333' as ExecutionId;
    const persistedResult = {
      category: 'toolUse' as const,
      outcome: 'completed' as const,
      response: 'Recovered review.',
      files: [],
      cost: 0,
    };
    const sequenceStore = stableSequenceStore(stableExecutionId, 1);
    const childStore = {
      listKeys: vi
        .fn()
        .mockResolvedValue(['stable-subagent-attempt', 'result-meta']),
      read: vi.fn().mockResolvedValue(stableAttempt(stableExecutionId)),
      readResultMeta: vi.fn().mockResolvedValue({
        producer: 'subagent',
        agentName: 'review',
        parentExecutionId: STABLE_PARENT_EXECUTION_ID,
        wallTimeMs: 100,
        result: persistedResult,
      }),
    };
    mocks.getExecutionStore.mockImplementation((executionId: ExecutionId) =>
      executionId === STABLE_PARENT_EXECUTION_ID ? sequenceStore : childStore,
    );
    const prepare = vi.fn(() =>
      Promise.reject(new Error('current agent is unavailable')),
    );

    await expect(
      executeStableSubagentInBand({
        executionId: stableExecutionId,
        parentExecutionId: STABLE_PARENT_EXECUTION_ID,
        prepare,
      }),
    ).resolves.toEqual({
      executionId: stableExecutionId,
      result: persistedResult,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(mocks.registerExecution).not.toHaveBeenCalled();
    expect(mocks.executeAgent).not.toHaveBeenCalled();
    expect(mocks.writeResultMeta).not.toHaveBeenCalled();
  });

  it('recovers a later completed attempt when an earlier child was deleted', async () => {
    const logicalExecutionId = 'cccccc444444' as ExecutionId;
    const persistedResult = {
      category: 'toolUse' as const,
      outcome: 'completed' as const,
      response: 'Recovered later attempt.',
      files: [],
      cost: 0,
    };
    const sequenceStore = stableSequenceStore(logicalExecutionId, 2);
    const missingStore = {
      listKeys: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockResolvedValue(undefined),
      readResultMeta: vi.fn().mockResolvedValue(null),
    };
    const completedStore = {
      listKeys: vi
        .fn()
        .mockResolvedValue(['stable-subagent-attempt', 'result-meta']),
      read: vi.fn().mockResolvedValue(stableAttempt(logicalExecutionId)),
      readResultMeta: vi.fn().mockResolvedValue({
        producer: 'subagent',
        agentName: 'review',
        parentExecutionId: STABLE_PARENT_EXECUTION_ID,
        wallTimeMs: 100,
        result: persistedResult,
      }),
    };
    mocks.getExecutionStore.mockImplementation((executionId: ExecutionId) => {
      if (executionId === STABLE_PARENT_EXECUTION_ID) return sequenceStore;
      return executionId === logicalExecutionId ? missingStore : completedStore;
    });
    const prepare = vi.fn();

    const recovered = await executeStableSubagentInBand({
      executionId: logicalExecutionId,
      parentExecutionId: STABLE_PARENT_EXECUTION_ID,
      prepare,
    });

    expect(recovered.result).toBe(persistedResult);
    expect(recovered.executionId).not.toBe(logicalExecutionId);
    expect(prepare).not.toHaveBeenCalled();
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it('rejects a result manifest with different parent lineage', async () => {
    const stableExecutionId = 'cccccc555555' as ExecutionId;
    const sequenceStore = stableSequenceStore(stableExecutionId, 1);
    const childStore = {
      listKeys: vi
        .fn()
        .mockResolvedValue(['stable-subagent-attempt', 'result-meta']),
      read: vi.fn().mockResolvedValue(stableAttempt(stableExecutionId)),
      readResultMeta: vi.fn().mockResolvedValue({
        producer: 'subagent',
        agentName: 'review',
        parentExecutionId: 'deadbeef',
        wallTimeMs: 100,
        result: {
          category: 'toolUse',
          outcome: 'completed',
          response: 'Wrong workflow.',
          files: [],
          cost: 0,
        },
      }),
    };
    mocks.getExecutionStore.mockImplementation((executionId: ExecutionId) =>
      executionId === STABLE_PARENT_EXECUTION_ID ? sequenceStore : childStore,
    );

    await expect(
      executeStableSubagentInBand({
        executionId: stableExecutionId,
        parentExecutionId: STABLE_PARENT_EXECUTION_ID,
        prepare: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(SubagentReconciliationError);
    expect(mocks.registerExecution).not.toHaveBeenCalled();
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it('refuses to repeat an incomplete stable child', async () => {
    const logicalExecutionId = 'dddddd444444' as ExecutionId;
    const sequenceStore = stableSequenceStore(logicalExecutionId, 1);
    const childStore = {
      listKeys: vi.fn().mockResolvedValue(['meta']),
      read: vi.fn().mockResolvedValue(undefined),
      readResultMeta: vi.fn().mockResolvedValue(null),
    };
    mocks.getExecutionStore.mockImplementation((executionId: ExecutionId) =>
      executionId === STABLE_PARENT_EXECUTION_ID ? sequenceStore : childStore,
    );

    await expect(
      executeSubagentInBand({
        executionId: logicalExecutionId,
        configPayload: {
          agent: 'review',
          agentCategory: AgentCategory.ToolUse,
          model: 'deepseekT',
        },
        agentName: 'review',
        parentExecutionId: STABLE_PARENT_EXECUTION_ID,
        parentStreamId: 'parent-stream' as StreamTabId,
        runtimeHost: runtimeHost(),
        session: defaultSession(),
      }),
    ).rejects.toBeInstanceOf(SubagentReconciliationError);
    expect(mocks.registerExecution).not.toHaveBeenCalled();
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it.each(['reserved', 'retryable'] as const)(
    'retries a %s child without a result manifest',
    async (phase) => {
      const logicalExecutionId = 'dddddd555555' as ExecutionId;
      const stores = new Map<ExecutionId, Record<string, unknown>>();
      const sequenceStore = stableSequenceStore(logicalExecutionId, 1);
      mocks.getExecutionStore.mockImplementation((id: ExecutionId) => {
        if (id === STABLE_PARENT_EXECUTION_ID) return sequenceStore;
        let store = stores.get(id);
        if (store) return store;
        store =
          id === logicalExecutionId
            ? {
                listKeys: vi
                  .fn()
                  .mockResolvedValue(['stable-subagent-attempt', 'config']),
                read: vi
                  .fn()
                  .mockResolvedValue(stableAttempt(logicalExecutionId, phase)),
                readResultMeta: vi.fn().mockResolvedValue(null),
              }
            : {
                listKeys: vi.fn().mockResolvedValue([]),
                read: vi.fn().mockResolvedValue(undefined),
                readResultMeta: vi.fn().mockResolvedValue(null),
                write: vi.fn().mockResolvedValue(undefined),
                writeResultMeta: mocks.writeResultMeta,
              };
        stores.set(id, store);
        return store;
      });

      const completed = await executeSubagentInBand({
        executionId: logicalExecutionId,
        configPayload: {
          agent: 'review',
          agentCategory: AgentCategory.ToolUse,
          model: 'deepseekT',
        },
        agentName: 'review',
        parentExecutionId: STABLE_PARENT_EXECUTION_ID,
        parentStreamId: 'parent-stream' as StreamTabId,
        runtimeHost: runtimeHost(),
        session: defaultSession(),
      });

      expect(completed.executionId).not.toBe(logicalExecutionId);
      expect(mocks.executeAgent).toHaveBeenCalledOnce();
    },
  );

  it('refuses to repeat a completed stable child when its manifest cannot be written', async () => {
    const logicalExecutionId = 'dddddd666666' as ExecutionId;
    const sequenceStore = stableSequenceStore(logicalExecutionId);
    let marker: ReturnType<typeof stableAttempt> | undefined;
    const write = vi.fn(async (key: string, value: typeof marker) => {
      if (key === 'stable-subagent-attempt') marker = value;
    });
    mocks.writeResultMeta.mockRejectedValueOnce(new Error('storage offline'));
    const childStore = {
      listKeys: vi.fn(async () => (marker ? ['stable-subagent-attempt'] : [])),
      read: vi.fn(async () => marker),
      readResultMeta: vi.fn().mockResolvedValue(null),
      write,
      writeResultMeta: mocks.writeResultMeta,
    };
    mocks.getExecutionStore.mockImplementation((executionId: ExecutionId) =>
      executionId === STABLE_PARENT_EXECUTION_ID ? sequenceStore : childStore,
    );
    const options = {
      executionId: logicalExecutionId,
      configPayload: {
        agent: 'review',
        agentCategory: AgentCategory.ToolUse,
        model: 'deepseekT',
      },
      agentName: 'review',
      parentExecutionId: STABLE_PARENT_EXECUTION_ID,
      parentStreamId: 'parent-stream' as StreamTabId,
      runtimeHost: runtimeHost(),
      session: defaultSession(),
    } as const;

    await expect(executeSubagentInBand(options)).rejects.toBeInstanceOf(
      SubagentDurabilityError,
    );

    expect(write).toHaveBeenLastCalledWith(
      'stable-subagent-attempt',
      expect.objectContaining({ phase: 'launched' }),
    );
    await expect(executeSubagentInBand(options)).rejects.toBeInstanceOf(
      SubagentReconciliationError,
    );
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
  });

  it('uses a new durable attempt after failed and cancelled children', async () => {
    const logicalExecutionId = 'eeeeee555555' as ExecutionId;
    const configPayload = {
      agent: 'review',
      agentCategory: AgentCategory.ToolUse,
      model: 'deepseekT',
    };
    const stores = new Map<ExecutionId, Record<string, unknown>>();
    const sequenceStore = stableSequenceStore(logicalExecutionId);
    const priorOutcomes = ['failed', 'cancelled'] as const;
    mocks.getExecutionStore.mockImplementation((id: ExecutionId) => {
      if (id === STABLE_PARENT_EXECUTION_ID) return sequenceStore;
      let store = stores.get(id);
      if (store) return store;
      const priorOutcome = priorOutcomes[stores.size];
      store = priorOutcome
        ? {
            listKeys: vi
              .fn()
              .mockResolvedValue(['stable-subagent-attempt', 'result-meta']),
            read: vi.fn().mockResolvedValue(stableAttempt(logicalExecutionId)),
            readResultMeta: vi.fn().mockResolvedValue({
              producer: 'subagent',
              agentName: 'review',
              parentExecutionId: STABLE_PARENT_EXECUTION_ID,
              wallTimeMs: 100,
              result: {
                category: 'toolUse',
                outcome: priorOutcome,
                response: '',
                files: [],
                cost: 0,
              },
            }),
          }
        : {
            listKeys: vi.fn().mockResolvedValue([]),
            read: vi.fn().mockResolvedValue(undefined),
            readResultMeta: vi.fn().mockResolvedValue(null),
            write: vi.fn().mockResolvedValue(undefined),
            writeResultMeta: mocks.writeResultMeta,
          };
      stores.set(id, store);
      return store;
    });

    const completed = await executeSubagentInBand({
      executionId: logicalExecutionId,
      configPayload,
      agentName: 'review',
      parentExecutionId: STABLE_PARENT_EXECUTION_ID,
      parentStreamId: 'parent-stream' as StreamTabId,
      runtimeHost: runtimeHost(),
      session: defaultSession(),
    });

    expect(completed.executionId).not.toBe(logicalExecutionId);
    expect(stores.size).toBe(3);
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
    expect(mocks.registerExecution).toHaveBeenCalledWith(
      completed.executionId,
      expect.anything(),
      'review',
      STABLE_PARENT_EXECUTION_ID,
    );
  });

  it('does not return a typed result when its durable manifest cannot be written', async () => {
    mocks.writeResultMeta.mockRejectedValueOnce(new Error('storage offline'));

    await expect(
      executeSubagentInBand({
        configPayload: {
          agent: 'review',
          agentCategory: AgentCategory.ToolUse,
          model: 'deepseekT',
        },
        agentName: 'review',
        parentExecutionId: 'parent-exec' as ExecutionId,
        parentStreamId: 'parent-stream' as StreamTabId,
        runtimeHost: runtimeHost(),
        session: defaultSession(),
      }),
    ).rejects.toBeInstanceOf(SubagentDurabilityError);
    expect(mocks.writeReport).not.toHaveBeenCalled();
  });

  it('preserves the child failure when its failure manifest cannot be written', async () => {
    mocks.executeAgent.mockRejectedValueOnce(new Error('review model failed'));
    mocks.writeResultMeta.mockRejectedValueOnce(new Error('storage offline'));

    const run = executeSubagentInBand({
      configPayload: {
        agent: 'review',
        agentCategory: AgentCategory.ToolUse,
        model: 'deepseekT',
      },
      agentName: 'review',
      parentExecutionId: 'parent-exec' as ExecutionId,
      parentStreamId: 'parent-stream' as StreamTabId,
      runtimeHost: runtimeHost(),
      session: defaultSession(),
    });

    await expect(run).rejects.toMatchObject({
      name: 'SubagentDurabilityError',
      message: expect.stringContaining('review model failed'),
      cause: expect.objectContaining({ name: 'AggregateError' }),
    });
  });

  it('preserves the child failure when its failure result cannot be constructed', async () => {
    mocks.executeAgent.mockRejectedValueOnce(
      new AgentFlowError('review model failed', {
        category: 'toolUse',
        outcome: 'failed',
        executionId: 'child-exec',
        streamId: 'child-stream',
        touchedFiles: [42],
      } as never),
    );

    const run = executeSubagentInBand({
      configPayload: {
        agent: 'review',
        agentCategory: AgentCategory.ToolUse,
        model: 'deepseekT',
      },
      agentName: 'review',
      parentExecutionId: 'parent-exec' as ExecutionId,
      parentStreamId: 'parent-stream' as StreamTabId,
      runtimeHost: runtimeHost(),
      session: defaultSession(),
    });

    await expect(run).rejects.toMatchObject({
      name: 'SubagentDurabilityError',
      message: expect.stringContaining('review model failed'),
      cause: expect.objectContaining({ name: 'AggregateError' }),
    });
    expect(mocks.writeResultMeta).not.toHaveBeenCalled();
  });

  it('does not rewrite a completed child when typed result construction fails', async () => {
    mocks.executeAgent.mockResolvedValueOnce({
      category: 'toolUse',
      outcome: 'completed',
      executionId: 'child-exec',
      streamId: 'child-stream',
      touchedFiles: [42],
    });

    await expect(
      executeSubagentInBand({
        configPayload: {
          agent: 'review',
          agentCategory: AgentCategory.ToolUse,
          model: 'deepseekT',
        },
        agentName: 'review',
        parentExecutionId: 'parent-exec' as ExecutionId,
        parentStreamId: 'parent-stream' as StreamTabId,
        runtimeHost: runtimeHost(),
        session: defaultSession(),
      }),
    ).rejects.toThrow();
    expect(mocks.writeResultMeta).not.toHaveBeenCalled();
    expect(mocks.writeReport).not.toHaveBeenCalled();
  });

  it('interrupts the live child when the in-band caller aborts', async () => {
    const controller = new AbortController();
    const onCost = vi.fn();
    let childReady!: () => void;
    let childInterrupted!: () => void;
    const ready = new Promise<void>((resolve) => {
      childReady = resolve;
    });
    const interrupted = new Promise<void>((resolve) => {
      childInterrupted = resolve;
    });
    const interrupt = vi.fn(() => {
      childInterrupted();
      return true;
    });
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      await options.onRun?.({ interrupt } as never);
      childReady();
      await interrupted;
      return {
        category: 'toolUse',
        outcome: 'cancelled',
        executionId: 'child-exec',
        streamId: 'child-stream',
      };
    });

    const run = executeSubagentInBand({
      configPayload: {
        agent: 'review',
        agentCategory: AgentCategory.ToolUse,
        model: 'deepseekT',
      },
      agentName: 'review',
      parentExecutionId: 'parent-exec' as ExecutionId,
      parentStreamId: 'parent-stream' as StreamTabId,
      runtimeHost: runtimeHost(),
      session: defaultSession(),
      signal: controller.signal,
      onCost,
    });
    await ready;
    controller.abort(new Error('Workflow stopped.'));

    await expect(run).rejects.toThrow('Workflow stopped.');
    expect(interrupt).toHaveBeenCalledOnce();
    expect(onCost).toHaveBeenCalledOnce();
    expect(mocks.writeResultMeta).toHaveBeenCalledOnce();
    expect(mocks.writeResultMeta).toHaveBeenLastCalledWith(
      expect.objectContaining({
        producer: 'subagent',
        result: expect.objectContaining({ outcome: 'cancelled' }),
      }),
    );
  });

  it('keeps the completed child result when cancellation arrives during persistence', async () => {
    const controller = new AbortController();
    let finishPersistence!: () => void;
    const persistencePending = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    mocks.writeResultMeta.mockReturnValueOnce(persistencePending);

    const run = executeSubagentInBand({
      configPayload: {
        agent: 'review',
        agentCategory: AgentCategory.ToolUse,
        model: 'deepseekT',
      },
      agentName: 'review',
      parentExecutionId: 'parent-exec' as ExecutionId,
      parentStreamId: 'parent-stream' as StreamTabId,
      runtimeHost: runtimeHost(),
      session: defaultSession(),
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(mocks.writeResultMeta).toHaveBeenCalledOnce();
    });
    controller.abort(new Error('Workflow stopped after child completion.'));
    finishPersistence();

    await expect(run).rejects.toThrow(
      'Workflow stopped after child completion.',
    );
    expect(mocks.writeResultMeta).toHaveBeenCalledOnce();
    expect(mocks.writeResultMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        producer: 'subagent',
        result: expect.objectContaining({ outcome: 'completed' }),
      }),
    );
  });

  it('does not register a child when the in-band caller is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Workflow already stopped.'));

    await expect(
      executeSubagentInBand({
        configPayload: {
          agent: 'review',
          agentCategory: AgentCategory.ToolUse,
          model: 'deepseekT',
        },
        agentName: 'review',
        parentExecutionId: 'parent-exec' as ExecutionId,
        parentStreamId: 'parent-stream' as StreamTabId,
        runtimeHost: runtimeHost(),
        session: defaultSession(),
        signal: controller.signal,
      }),
    ).rejects.toThrow('Workflow already stopped.');
    expect(mocks.registerExecution).not.toHaveBeenCalled();
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it('carries the validated agent source to executeAgent for source-pinned launch', async () => {
    // The delegation validates via getVisibleAgent and must hand the resolved
    // entry's source to executeAgent, so getAgentPath resolves the exact
    // (source, name) key instead of re-resolving the ambiguous bare name.
    await withRunContext(
      createRunContext({
        runtimeHost: runtimeHost(),
        streamId: 'parent-stream',
        executionId: 'parent-exec',
        model: 'deepseekT',
        stopAfterCycle: true,
      }),
      () => callDelegateReview(),
    );

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'review',
        agentSource: 'builtInToolUse',
      }),
      expect.any(String),
      expect.anything(),
    );
  });

  it('adds a substantive handoff requirement to tool-use subagent instructions', async () => {
    await withRunContext(
      createRunContext({
        runtimeHost: runtimeHost(),
        streamId: 'parent-stream',
        executionId: 'parent-exec',
        model: 'deepseekT',
      }),
      () => callDelegateReview(),
    );

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: expect.stringContaining(
          'Your final response is delivered verbatim to the parent orchestrator.',
        ),
      }),
      expect.any(String),
      expect.anything(),
    );
    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: expect.stringContaining(
          'Do not finish with only status/process notes',
        ),
      }),
      expect.any(String),
      expect.anything(),
    );
    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: expect.stringContaining(
          'Follow any tool, network, file, approval',
        ),
      }),
      expect.any(String),
      expect.anything(),
    );
    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: expect.stringContaining(
          'report the conflict instead of guessing permission',
        ),
      }),
      expect.any(String),
      expect.anything(),
    );
  });

  it('carries the current parent instruction into the subagent constraint context', async () => {
    const parentInstruction =
      'Do not use plans, todos, files, bash, Wolfram, or other child tools. Delegate exactly once.';
    await withToolFileInteractionContext(
      {
        tracker: {} as never,
        userInstruction: parentInstruction,
      },
      () =>
        withRunContext(
          createRunContext({
            runtimeHost: runtimeHost(),
            streamId: 'parent-stream',
            executionId: 'parent-exec',
            model: 'deepseekT',
          }),
          () => callDelegateReview(),
        ),
    );

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        rootUserInstruction: parentInstruction,
        instruction: expect.stringContaining(
          `Parent user request (constraint context only):\n${parentInstruction}`,
        ),
      }),
      expect.any(String),
      expect.anything(),
    );
  });

  it('tells orchestrators that delegated instructions must carry parent constraints', () => {
    const parameters = new DelegateAgentTool().definition.parameters as {
      properties?: Record<string, { description?: string }>;
    };
    const instructionDescription =
      parameters.properties?.instruction?.description ?? '';

    expect(instructionDescription).toContain(
      'copy every relevant parent constraint',
    );
    expect(instructionDescription).toContain('tool/network/file/approval');
    expect(instructionDescription).toContain(
      'does not automatically inherit the parent conversation',
    );
  });

  it('tells orchestrators to preserve delegated result evidence when summarizing', () => {
    const description = new DelegateAgentTool().definition.description;

    expect(description).toContain('preserve its stated evidence');
    expect(description).toContain('tool names');
    expect(description).toContain('do not substitute or invent methods');
  });

  it('formats returned child error results as subagent errors', async () => {
    const recordSubagentCost = vi.fn();
    mockExecuteAgentErrorOnce(0.42);

    const result = await withToolFileInteractionContext(
      { tracker: {} as never, hooks: { recordSubagentCost } },
      () =>
        withRunContext(
          createRunContext({
            runtimeHost: runtimeHost(),
            streamId: 'parent-stream',
            executionId: 'parent-exec',
            model: 'deepseekT',
            stopAfterCycle: true,
          }),
          () => callDelegateReview(),
        ),
    );

    expect(result.summary).toBe("Subagent 'review' failed");
    expect(result.status).toBe('error');
    expect(result.error).toBe('review model failed');
    expect(mocks.writeReport).toHaveBeenCalledWith(
      expect.stringContaining('<subagent-error'),
    );
    expect(mocks.writeReport).toHaveBeenCalledWith(
      expect.stringContaining('review model failed'),
    );
    expect(recordSubagentCost).toHaveBeenCalledTimes(1);
    expect(recordSubagentCost).toHaveBeenCalledWith(0.42);
  });

  it('rolls up thrown child error results during one-shot runs', async () => {
    const recordSubagentCost = vi.fn();
    mocks.executeAgent.mockRejectedValueOnce(
      new AgentFlowError('review model failed', {
        category: 'toolUse',
        outcome: 'failed',
        executionId: 'child-exec',
        streamId: 'child-stream',
        totalCostUsd: 0.57,
      }),
    );

    const result = await withToolFileInteractionContext(
      { tracker: {} as never, hooks: { recordSubagentCost } },
      () =>
        withRunContext(
          createRunContext({
            runtimeHost: runtimeHost(),
            streamId: 'parent-stream',
            executionId: 'parent-exec',
            model: 'deepseekT',
            stopAfterCycle: true,
          }),
          () => callDelegateReview(),
        ),
    );

    expect(result.summary).toBe("Subagent 'review' failed");
    expect(result.status).toBe('error');
    expect(result.error).toBe('review model failed');
    expect(recordSubagentCost).toHaveBeenCalledTimes(1);
    expect(recordSubagentCost).toHaveBeenCalledWith(0.57);
  });

  it('rolls up failed async subagent cost from the error callback', async () => {
    const recordSubagentCost = vi.fn();
    mockExecuteAgentErrorOnce(0.31);

    const result = await withToolFileInteractionContext(
      { tracker: {} as never, hooks: { recordSubagentCost } },
      () =>
        withRunContext(
          createRunContext({
            runtimeHost: runtimeHost(),
            streamId: 'parent-stream',
            executionId: 'parent-exec',
            model: 'deepseekT',
          }),
          () => callDelegateReview(),
        ),
    );

    expect(result.summary).toBe("Launched 'review' (async)");
    await vi.waitFor(() => {
      expect(recordSubagentCost).toHaveBeenCalledTimes(1);
    });
    expect(recordSubagentCost).toHaveBeenCalledWith(0.31);
  });

  it('keeps interactive delegations asynchronous', async () => {
    const result = await withRunContext(
      createRunContext({
        runtimeHost: runtimeHost(),
        streamId: 'parent-stream',
        executionId: 'parent-exec',
        model: 'deepseekT',
      }),
      () => callDelegateReview(),
    );

    expect(result.summary).toBe("Launched 'review' (async)");
    expect(result.output).toContain(
      "Subagent 'review' launched. Result will be delivered automatically",
    );
    const executeOptions = mocks.executeAgent.mock.calls.at(-1)?.[2];
    expect(executeOptions).toEqual(
      expect.objectContaining({
        onRun: expect.any(Function),
        session: expect.any(Object),
      }),
    );
    expect(executeOptions).not.toEqual(
      expect.objectContaining({ stopAfterCycle: true }),
    );
  });

  it('discourages equivalent delegation retries after a no-feedback rejection', async () => {
    mocks.isProposalBypassed.mockReturnValue(false);
    const host = runtimeHost();
    host.interactions!.requestAgentProposal = vi
      .fn()
      .mockResolvedValue({ action: 'reject' });

    const session = sessionFor(host);
    const result = await withRunContext(
      createRunContext({
        runtimeHost: host,
        streamId: 'parent-stream',
        executionId: 'parent-exec',
        model: 'deepseekT',
        session,
      }),
      () => callDelegateReview(),
    );
    session.dispose();

    expect(result.summary).toBe("User rejected delegation to 'review'");
    expect(result.status).toBe('error');
    expect(result.error).toContain('No feedback provided.');
    expect(result.error).toContain(
      'Do not retry the same or equivalent delegation',
    );
    expect(result.error).toContain('continue directly with available context');
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it('rejects an approved model override unavailable in the active API mode', async () => {
    mocks.isProposalBypassed.mockReturnValue(false);
    // Only deepseekT is available; gpt5 is not — the override must be rejected
    // synchronously, mirroring the initial delegate path's availability gate.
    mocks.computeModelOptionsData.mockResolvedValue([
      {
        value: 'deepseekT',
        label: 'DeepSeek',
        disabled: false,
        requiresKey: false,
      },
    ]);
    const host = runtimeHost();
    host.interactions!.requestAgentProposal = vi
      .fn()
      .mockResolvedValue({ action: 'approve', model: 'gpt5' });

    const session = sessionFor(host);
    const result = await withRunContext(
      createRunContext({
        runtimeHost: host,
        streamId: 'parent-stream',
        executionId: 'parent-exec',
        model: 'deepseekT',
        session,
      }),
      () => callDelegateReview(),
    );
    session.dispose();

    expect(result.status).toBe('error');
    expect(result.summary).toBe(
      "Approved model override 'gpt5' is not available",
    );
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it('launches with an approved model override that is available', async () => {
    mocks.isProposalBypassed.mockReturnValue(false);
    mocks.computeModelOptionsData.mockResolvedValue([
      {
        value: 'deepseekT',
        label: 'DeepSeek',
        disabled: false,
        requiresKey: false,
      },
      { value: 'gpt5', label: 'GPT-5', disabled: false, requiresKey: false },
    ]);
    const host = runtimeHost();
    host.interactions!.requestAgentProposal = vi
      .fn()
      .mockResolvedValue({ action: 'approve', model: 'gpt5' });

    const session = sessionFor(host);
    const result = await withRunContext(
      createRunContext({
        runtimeHost: host,
        streamId: 'parent-stream',
        executionId: 'parent-exec',
        model: 'deepseekT',
        session,
      }),
      () => callDelegateReview(),
    );
    session.dispose();

    expect(result.status).toBe('executed');
    expect(result.summary).toBe("Launched 'review' (async)");
    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt5' }),
      expect.any(String),
      expect.anything(),
    );
  });

  it('canonicalizes legacy tool-use agent names before launch', async () => {
    mocks.getVisibleAgents.mockReturnValue([
      {
        name: 'assistant',
        description: 'General assistant.',
        tools: [],
      },
    ]);
    mocks.getVisibleAgent.mockImplementation(
      (_category: AgentCategory, name: string) =>
        name === 'chat' || name === 'assistant'
          ? { name: 'assistant' }
          : undefined,
    );

    const result = await withRunContext(
      createRunContext({
        runtimeHost: runtimeHost(),
        streamId: 'parent-stream',
        executionId: 'parent-exec',
        model: 'deepseekT',
      }),
      () => callDelegateReview('chat'),
    );

    expect(result.summary).toBe("Launched 'assistant' (async)");
    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'assistant',
        agentCategory: AgentCategory.ToolUse,
      }),
      expect.any(String),
      expect.anything(),
    );
  });

  it('includes memory misses in interactive early-delivered reports', async () => {
    const parentStreamId = 'parent-stream' as StreamTabId;
    const childStreamId = 'child-stream' as StreamTabId;
    const host = runtimeHost();

    // Async delegation is now driven by the child-run loop over
    // NativeToolUseStrategy: `executeAgent` (mocked here) is the loop's
    // `launch` turn, and a returned WAITING result is the loop's one
    // delivery site's input — there is no more onBeforeWaiting callback.
    mocks.executeAgent.mockImplementationOnce(
      async (_config, executionId: string, options) => {
        const handle = new AgentExecutionHandle(
          executionId,
          parentStreamId,
          childStreamId,
          'review',
          'toolUse',
          host,
        );
        defaultSession().executions.track(handle);
        options.onStreamResolved?.(childStreamId);
        options.onRun?.(handle);
        return {
          category: 'toolUse',
          outcome: STREAM_PHASE.WAITING,
          lastResponse: 'The proof is correct.',
          touchedFiles: [],
          executionId,
          streamId: childStreamId,
          memoryMisses: [
            { path: '/memories/missing.md', reason: 'not found & unreadable' },
          ],
        };
      },
    );

    await withRunContext(
      createRunContext({
        runtimeHost: host,
        streamId: parentStreamId,
        executionId: 'parent-exec',
        model: 'deepseekT',
      }),
      () => callDelegateReview(),
    );

    await vi.waitFor(() => {
      expect(mocks.writeReport).toHaveBeenCalledWith(
        expect.stringContaining(
          '<memory-miss path="/memories/missing.md" reason="not found &amp; unreadable" />',
        ),
      );
    });
  });

  it('does not deliver detached subagent results back to the released parent', async () => {
    const parentStreamId = 'parent-stream' as StreamTabId;
    const childStreamId = 'child-stream' as StreamTabId;
    const host = runtimeHost();
    let capturedHandle: AgentExecutionHandle | undefined;

    mocks.executeAgent.mockImplementationOnce(
      async (_config, executionId: string, options) => {
        const handle = new AgentExecutionHandle(
          executionId,
          parentStreamId,
          childStreamId,
          'review',
          'toolUse',
          host,
        );
        defaultSession().executions.track(handle);
        capturedHandle = handle;
        options.onStreamResolved?.(childStreamId);
        options.onRun?.(handle);
        // Detach happens between the loop capturing the handle (onRun, above)
        // and the loop delivering this turn's result (after this resolves) —
        // the same ordering a real stop-with-detach produces mid-turn.
        defaultSession().executions.detachActiveChildren(parentStreamId, host);
        return {
          category: 'toolUse',
          outcome: STREAM_PHASE.WAITING,
          lastResponse: 'The proof is correct.',
          touchedFiles: [],
          executionId,
          streamId: childStreamId,
        };
      },
    );

    await withRunContext(
      createRunContext({
        runtimeHost: host,
        streamId: parentStreamId,
        executionId: 'parent-exec',
        model: 'deepseekT',
      }),
      () => callDelegateReview(),
    );

    await vi.waitFor(() => {
      expect(mocks.writeReport).toHaveBeenCalledWith(
        expect.stringContaining('The proof is correct.'),
      );
    });
    expect(capturedHandle?.deliveryTargetStreamId).toBeUndefined();
    expect(defaultSession().followUps.getAll(parentStreamId)).toEqual([]);
    expect(defaultSession().followUps.getAll(childStreamId)).toEqual([]);
  });
});
