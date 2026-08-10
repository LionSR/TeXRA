// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRunContext,
  withRunContext,
  type RunContext,
} from '@agent/runtime/RunContext';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import type { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import { markOwnedExecutionLeaseUndurable } from '@agent/storage/executionLease';
import {
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { createTestSession } from '@test/support/sessionTestUtils';
import { DelegateAgentTool } from '@tools/delegation/DelegationTools';
import {
  executeStableSubagentInBand,
  SubagentDurabilityError,
  SubagentReconciliationError,
  type InBandSubagentExecutionOptions,
} from '@tools/delegation/inBandSubagentExecution';

const mocks = vi.hoisted(() => ({
  configureDelegatedChildApprovals: vi.fn(),
  executeAgent: vi.fn(),
  getExecutionStore: vi.fn(),
  getVisibleAgent: vi.fn(),
  getVisibleAgents: vi.fn(),
  isApprovalBypassedForStream: vi.fn(),
  isProposalBypassed: vi.fn(),
  registerExecution: vi.fn(),
  releaseOwnedExecutionLease: vi.fn(),
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

// The launch sites register through `registerOwnedExecution`, which calls
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

vi.mock('@agent/storage/executionLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/executionLease')>()),
  captureOwnedExecutionLease:
    (_executionId: ExecutionId) => (operation: () => unknown) =>
      operation(),
  markOwnedExecutionLeaseUndurable: vi.fn(),
  ownsExecutionLease: vi.fn(() => true),
  runWithOwnedExecutionLease: vi.fn(
    (_executionId: ExecutionId, operation: () => unknown) => operation(),
  ),
}));

vi.mock('@agent/runtime/executionOwnership', () => ({
  releaseExecutionLeaseAfterArtifacts: vi.fn(
    async (_session: unknown, executionId: ExecutionId) =>
      mocks.releaseOwnedExecutionLease(executionId),
  ),
}));

// `persistChildRun*` moved to `@agent/storage/childRunPersistence`, which
// imports the store module-internally rather than through the mocked
// `@agent/storage` index; route it through the store spy the way the deleted
// delegation-side module did.
vi.mock('@agent/storage/childRunPersistence', () => {
  const persist = async (
    write: () => Promise<unknown>,
  ): Promise<{ kind: 'persisted' } | { kind: 'failed'; err: unknown }> => {
    try {
      await write();
      return { kind: 'persisted' };
    } catch (err) {
      return { kind: 'failed', err };
    }
  };
  return {
    persistChildRunReport: (executionId: ExecutionId, message: string) =>
      persist(() => mocks.getExecutionStore(executionId).writeReport(message)),
    persistChildRunResultMeta: (executionId: ExecutionId, resultMeta: unknown) =>
      persist(() =>
        mocks.getExecutionStore(executionId).writeResultMeta(resultMeta),
      ),
    persistChildRunTurnState: (executionId: ExecutionId, state: unknown) =>
      persist(() => mocks.getExecutionStore(executionId).writeTurnState(state)),
  };
});

vi.mock('@model/computeModelOptions', () => ({
  computeModelOptionsData: mocks.computeModelOptionsData,
}));

vi.mock('@tools/approval', () => ({
  configureDelegatedChildApprovals: mocks.configureDelegatedChildApprovals,
  isApprovalBypassedForStream: mocks.isApprovalBypassedForStream,
  proposalApprovals: () => ({
    isBypassed: mocks.isProposalBypassed,
  }),
}));

const PARENT_STREAM_ID = 'parent-stream' as StreamTabId;
const CHILD_STREAM_ID = 'child-stream' as StreamTabId;

/** The run context shared by nearly every case (stream/stopAfterCycle/session vary). */
function parentRunContext(
  overrides: Partial<{
    streamId: StreamTabId;
    stopAfterCycle: boolean;
    session: SessionHandle;
  }> = {},
): RunContext {
  return createRunContext({
    streamId: PARENT_STREAM_ID,
    executionId: 'parent-exec',
    modelCell: { modelId: 'deepseekT' },
    session: defaultSession(),
    ...overrides,
  });
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

/** The same delegation routed through the host's proposal port, with the host
 *  fake answering `decision`. The session owns the fake port, so it is created
 *  and disposed per case. */
async function delegateWithProposalDecision(
  decision:
    | { readonly action: 'reject' }
    | { readonly action: 'approve'; readonly model: string },
) {
  mocks.isProposalBypassed.mockReturnValue(false);
  const session = createTestSession();
  session.useHostInteractions({
    cancel: vi.fn(),
    requestAgentProposal: vi.fn().mockResolvedValue(decision),
  } satisfies HostInteractions);
  try {
    return await withRunContext(parentRunContext({ session }), () =>
      callDelegateReview(),
    );
  } finally {
    session.dispose();
  }
}

const STABLE_PARENT_EXECUTION_ID = 'abcdef123456' as ExecutionId;
const IN_BAND_LOGICAL_EXECUTION_ID = 'aaaaaa111111' as ExecutionId;

/** The in-band delegation options shared by nearly every case (fields vary). */
function delegationOptions(
  overrides: Partial<InBandSubagentExecutionOptions> = {},
): InBandSubagentExecutionOptions {
  return {
    configPayload: {
      agent: 'review',
      agentCategory: AgentCategory.ToolUse,
      model: 'deepseekT',
    },
    agentName: 'review',
    parentExecutionId: STABLE_PARENT_EXECUTION_ID,
    parentStreamId: PARENT_STREAM_ID,
    session: defaultSession(),
    ...overrides,
  };
}

/** Run the typed required-result path the way production callers reach it. */
function runInBand(
  options: InBandSubagentExecutionOptions,
  executionId: ExecutionId = IN_BAND_LOGICAL_EXECUTION_ID,
) {
  return executeStableSubagentInBand({
    executionId,
    parentExecutionId: options.parentExecutionId,
    signal: options.signal,
    prepare: async () => options,
  });
}

/**
 * One-shot executeAgent mock that reports a failed child via onRunError and
 * returns the same failed result, carrying the given subagent cost.
 */
function mockExecuteAgentErrorOnce(
  totalCostUsd: number,
  extra: Record<string, unknown> = {},
): void {
  mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
    const failed = {
      category: 'toolUse',
      outcome: 'failed',
      executionId: 'child-exec',
      streamId: 'child-stream',
      totalCostUsd,
      ...extra,
    };
    await options.onRunError?.(new Error('review model failed'), failed);
    return failed;
  });
}

/** The shared rejection shape when the child failed AND its manifest write failed. */
async function expectDurabilityErrorPreservingChildFailure(
  run: Promise<unknown>,
): Promise<void> {
  await expect(run).rejects.toMatchObject({
    name: 'SubagentDurabilityError',
    message: expect.stringContaining('review model failed'),
    cause: expect.objectContaining({ name: 'AggregateError' }),
  });
}

/**
 * One-shot executeAgent mock that tracks a live child handle and returns the
 * WAITING result the child-run loop delivers from.
 */
function mockWaitingChildOnce(
  options: {
    memoryMisses?: ReadonlyArray<{ path: string; reason: string }>;
    afterRun?: (handle: AgentExecutionHandle) => void;
  } = {},
): void {
  mocks.executeAgent.mockImplementationOnce(
    async (_config, executionId: string, runOptions) => {
      const handle = testExecutionHandle({
        executionId,
        parentStreamId: PARENT_STREAM_ID,
        childStreamId: CHILD_STREAM_ID,
        agent: 'review',
      });
      defaultSession().executions.track(handle);
      runOptions.onStreamResolved?.(CHILD_STREAM_ID);
      runOptions.onRun?.(handle);
      options.afterRun?.(handle);
      return {
        category: 'toolUse',
        outcome: STREAM_PHASE.WAITING,
        response: 'The proof is correct.',
        files: [],
        executionId,
        streamId: CHILD_STREAM_ID,
        ...(options.memoryMisses ? { memoryMisses: options.memoryMisses } : {}),
      };
    },
  );
}

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

/** In-memory execution KV store: enough surface for the stable attempt path. */
function memoryExecutionStore() {
  const kv = new Map<string, unknown>();
  return {
    listKeys: vi.fn(async () => [...kv.keys()]),
    read: vi.fn(async (key: string) => kv.get(key)),
    write: vi.fn(async (key: string, value: unknown) => {
      kv.set(key, value);
    }),
    readResultMeta: vi.fn(async () => null),
    writeReport: mocks.writeReport,
    writeResultMeta: mocks.writeResultMeta,
  };
}

/** Child store with nothing persisted: what a fresh attempt starts from. */
function emptyChildStore() {
  return {
    listKeys: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockResolvedValue(undefined),
    readResultMeta: vi.fn().mockResolvedValue(null),
  };
}

/** Child store holding a launched attempt marker and its result manifest. */
function completedChildStore(
  logicalExecutionId: ExecutionId,
  result: unknown,
  parentExecutionId: string = STABLE_PARENT_EXECUTION_ID,
) {
  return {
    listKeys: vi
      .fn()
      .mockResolvedValue(['stable-subagent-attempt', 'result-meta']),
    read: vi.fn().mockResolvedValue(stableAttempt(logicalExecutionId)),
    readResultMeta: vi.fn().mockResolvedValue({
      producer: 'subagent',
      agentName: 'review',
      parentExecutionId,
      wallTimeMs: 100,
      result,
    }),
  };
}

/** Route parent reads to the sequence store and every child read elsewhere. */
function useStableStores(sequenceStore: unknown, childStore: unknown): void {
  mocks.getExecutionStore.mockImplementation((executionId: ExecutionId) =>
    executionId === STABLE_PARENT_EXECUTION_ID ? sequenceStore : childStore,
  );
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
    mocks.releaseOwnedExecutionLease.mockResolvedValue(undefined);
    mocks.writeReport.mockResolvedValue(undefined);
    mocks.writeResultMeta.mockResolvedValue(undefined);
    const memoryStores = new Map<
      ExecutionId,
      ReturnType<typeof memoryExecutionStore>
    >();
    mocks.getExecutionStore.mockImplementation((executionId: ExecutionId) => {
      let store = memoryStores.get(executionId);
      if (!store) {
        store = memoryExecutionStore();
        memoryStores.set(executionId, store);
      }
      return store;
    });
    mocks.executeAgent.mockResolvedValue({
      category: 'toolUse',
      outcome: 'completed',
      executionId: 'child-exec',
      streamId: 'child-stream',
      response: 'The proof is correct.',
      files: [],
    });
  });

  afterEach(() => {
    for (const executionId of defaultSession().executions.getActiveIds()) {
      defaultSession().executions.untrack(executionId);
    }
    defaultSession().followUps.terminalize(PARENT_STREAM_ID);
    defaultSession().followUps.terminalize(CHILD_STREAM_ID);
  });

  it('awaits child delegation during one-shot tool-use runs', async () => {
    const result = await withRunContext(
      parentRunContext({ stopAfterCycle: true }),
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

  it('marks the execution lease undurable when the in-band delivery report write fails', async () => {
    mocks.writeReport.mockRejectedValueOnce(new Error('disk full'));

    const result = await withRunContext(
      parentRunContext({ stopAfterCycle: true }),
      () => callDelegateReview(),
    );

    // The delivery XML still returns synchronously: a persistence hiccup on
    // the best-effort path never fails a call whose result already returned
    // inline (PersistenceMode's `best-effort-delivery`). What is lost is the
    // durable report copy, so the lease must be marked undurable — mirroring
    // `childRunLoop.ts`'s twin marks.
    expect(result.status).toBe('executed');
    expect(result.summary).toBe("Completed 'review'");
    const executionId = mocks.registerExecution.mock.calls[0]?.[0];
    expect(executionId).toEqual(expect.any(String));
    expect(markOwnedExecutionLeaseUndurable).toHaveBeenCalledWith(executionId);
  });

  it('composes durable workflow calls through the native launch primitive', async () => {
    const result = await runInBand(
      delegationOptions({ workflowPhase: 'proof-review' }),
    );

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'review' }),
      result.executionId,
      expect.objectContaining({
        stopAfterCycle: true,
        workflowPhase: 'proof-review',
      }),
    );
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
      expect.objectContaining({
        parentExecutionId: STABLE_PARENT_EXECUTION_ID,
        streamId: expect.stringContaining(`#${result.executionId}`),
      }),
    );
    expect(mocks.writeResultMeta).toHaveBeenCalledWith({
      producer: 'subagent',
      agentName: 'review',
      parentExecutionId: STABLE_PARENT_EXECUTION_ID,
      wallTimeMs: expect.any(Number),
      result: result.result,
    });
    expect(mocks.writeResultMeta.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.releaseOwnedExecutionLease.mock.invocationCallOrder[0],
    );
  });

  it('records a failed child cost once for durable in-band execution', async () => {
    const onCost = vi.fn();
    mockExecuteAgentErrorOnce(0.61, {
      executionId: IN_BAND_LOGICAL_EXECUTION_ID,
      response: 'Partial review.',
    });

    await expect(runInBand(delegationOptions({ onCost }))).rejects.toThrow(
      'review model failed',
    );

    expect(onCost).toHaveBeenCalledOnce();
    expect(onCost).toHaveBeenCalledWith(0.61);
    expect(mocks.writeResultMeta).toHaveBeenCalledOnce();
    expect(mocks.writeResultMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          cost: 0.61,
          outcome: 'failed',
          response: 'Partial review.',
        }),
      }),
    );
  });

  it('persists a cost-bearing WAITING result as a durable single-cycle failure', async () => {
    const onCost = vi.fn();
    mocks.executeAgent.mockResolvedValueOnce({
      category: 'toolUse',
      outcome: STREAM_PHASE.WAITING,
      executionId: IN_BAND_LOGICAL_EXECUTION_ID,
      streamId: 'child-stream',
      response: 'Waiting for clarification.',
      totalCostUsd: 0.73,
    });

    await expect(runInBand(delegationOptions({ onCost }))).rejects.toThrow(
      `Single-cycle subagent ${IN_BAND_LOGICAL_EXECUTION_ID} unexpectedly suspended.`,
    );

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.any(Object),
      IN_BAND_LOGICAL_EXECUTION_ID,
      expect.objectContaining({
        allowWaitingResult: true,
        stopAfterCycle: true,
      }),
    );
    expect(onCost).toHaveBeenCalledOnce();
    expect(onCost).toHaveBeenCalledWith(0.73);
    expect(mocks.writeResultMeta).toHaveBeenCalledOnce();
    expect(mocks.writeResultMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          cost: 0.73,
          outcome: 'failed',
          response: 'Waiting for clarification.',
        }),
      }),
    );
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
    useStableStores(
      sequenceStore,
      completedChildStore(stableExecutionId, persistedResult),
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
    const missingStore = emptyChildStore();
    const completedStore = completedChildStore(
      logicalExecutionId,
      persistedResult,
    );
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
    useStableStores(
      sequenceStore,
      completedChildStore(
        stableExecutionId,
        {
          category: 'toolUse',
          outcome: 'completed',
          response: 'Wrong workflow.',
          files: [],
          cost: 0,
        },
        'deadbeef',
      ),
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
    useStableStores(sequenceStore, {
      ...emptyChildStore(),
      listKeys: vi.fn().mockResolvedValue(['meta']),
    });

    await expect(
      runInBand(delegationOptions(), logicalExecutionId),
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
                ...emptyChildStore(),
                listKeys: vi
                  .fn()
                  .mockResolvedValue(['stable-subagent-attempt', 'config']),
                read: vi
                  .fn()
                  .mockResolvedValue(stableAttempt(logicalExecutionId, phase)),
              }
            : {
                ...emptyChildStore(),
                write: vi.fn().mockResolvedValue(undefined),
                writeResultMeta: mocks.writeResultMeta,
              };
        stores.set(id, store);
        return store;
      });

      const completed = await runInBand(
        delegationOptions(),
        logicalExecutionId,
      );

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
    useStableStores(sequenceStore, {
      ...emptyChildStore(),
      listKeys: vi.fn(async () => (marker ? ['stable-subagent-attempt'] : [])),
      read: vi.fn(async () => marker),
      write,
      writeResultMeta: mocks.writeResultMeta,
    });
    const options = delegationOptions();

    await expect(runInBand(options, logicalExecutionId)).rejects.toBeInstanceOf(
      SubagentDurabilityError,
    );

    expect(write).toHaveBeenLastCalledWith(
      'stable-subagent-attempt',
      expect.objectContaining({ phase: 'launched' }),
    );
    await expect(runInBand(options, logicalExecutionId)).rejects.toBeInstanceOf(
      SubagentReconciliationError,
    );
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
  });

  it('uses a new durable attempt after failed and cancelled children', async () => {
    const logicalExecutionId = 'eeeeee555555' as ExecutionId;
    const stores = new Map<ExecutionId, Record<string, unknown>>();
    const sequenceStore = stableSequenceStore(logicalExecutionId);
    const priorOutcomes = ['failed', 'cancelled'] as const;
    mocks.getExecutionStore.mockImplementation((id: ExecutionId) => {
      if (id === STABLE_PARENT_EXECUTION_ID) return sequenceStore;
      let store = stores.get(id);
      if (store) return store;
      const priorOutcome = priorOutcomes[stores.size];
      store = priorOutcome
        ? completedChildStore(logicalExecutionId, {
            category: 'toolUse',
            outcome: priorOutcome,
            response: '',
            files: [],
            cost: 0,
          })
        : {
            ...emptyChildStore(),
            write: vi.fn().mockResolvedValue(undefined),
            writeResultMeta: mocks.writeResultMeta,
          };
      stores.set(id, store);
      return store;
    });

    const completed = await runInBand(delegationOptions(), logicalExecutionId);

    expect(completed.executionId).not.toBe(logicalExecutionId);
    expect(stores.size).toBe(3);
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
    expect(mocks.registerExecution).toHaveBeenCalledWith(
      completed.executionId,
      expect.anything(),
      'review',
      expect.objectContaining({
        parentExecutionId: STABLE_PARENT_EXECUTION_ID,
        streamId: expect.stringContaining(`#${completed.executionId}`),
      }),
    );
  });

  it('does not return a typed result when its durable manifest cannot be written', async () => {
    mocks.writeResultMeta.mockRejectedValueOnce(new Error('storage offline'));

    await expect(runInBand(delegationOptions())).rejects.toBeInstanceOf(
      SubagentDurabilityError,
    );
    expect(mocks.writeReport).not.toHaveBeenCalled();
  });

  it('preserves the child failure when final lease cleanup also fails', async () => {
    const childFailure = new Error('review model failed');
    mocks.executeAgent.mockRejectedValueOnce(childFailure);
    mocks.releaseOwnedExecutionLease.mockRejectedValueOnce(
      new Error('artifact flush failed'),
    );

    await expect(runInBand(delegationOptions())).rejects.toBe(childFailure);
  });

  it('surfaces final lease cleanup failure after a successful child', async () => {
    mocks.releaseOwnedExecutionLease.mockRejectedValueOnce(
      new Error('artifact flush failed'),
    );

    await expect(runInBand(delegationOptions())).rejects.toThrow(
      'artifact flush failed',
    );
  });

  it('preserves the child failure when its failure manifest cannot be written', async () => {
    mocks.executeAgent.mockRejectedValueOnce(new Error('review model failed'));
    mocks.writeResultMeta.mockRejectedValueOnce(new Error('storage offline'));

    await expectDurabilityErrorPreservingChildFailure(
      runInBand(delegationOptions()),
    );
  });

  it('preserves the child failure when its failure result cannot be constructed', async () => {
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      const failed = {
        category: 'toolUse',
        outcome: 'failed',
        executionId: 'child-exec',
        streamId: 'child-stream',
        files: [42],
      } as never;
      await options.onRunError?.(new Error('review model failed'), failed);
      return failed;
    });

    const run = runInBand(delegationOptions());

    await expectDurabilityErrorPreservingChildFailure(run);
    expect(mocks.writeResultMeta).not.toHaveBeenCalled();
  });

  it('does not rewrite a completed child when typed result construction fails', async () => {
    mocks.executeAgent.mockResolvedValueOnce({
      category: 'toolUse',
      outcome: 'completed',
      executionId: 'child-exec',
      streamId: 'child-stream',
      files: [42],
    });

    await expect(runInBand(delegationOptions())).rejects.toThrow();
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

    const run = runInBand(
      delegationOptions({ signal: controller.signal, onCost }),
    );
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

    const run = runInBand(delegationOptions({ signal: controller.signal }));
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
      runInBand(delegationOptions({ signal: controller.signal })),
    ).rejects.toThrow('Workflow already stopped.');
    expect(mocks.registerExecution).not.toHaveBeenCalled();
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it('carries the validated agent source to executeAgent for source-pinned launch', async () => {
    // The delegation validates via getVisibleAgent and must hand the resolved
    // entry's source to executeAgent, so getAgentPath resolves the exact
    // (source, name) key instead of re-resolving the ambiguous bare name.
    await withRunContext(parentRunContext({ stopAfterCycle: true }), () =>
      callDelegateReview(),
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
    await withRunContext(parentRunContext(), () => callDelegateReview());

    const instruction = mocks.executeAgent.mock.calls.at(-1)?.[0].instruction;
    expect(instruction).toContain(
      'Your final response is delivered verbatim to the parent orchestrator',
    );
    expect(instruction).toContain('never only a status note');
    expect(instruction).toContain(
      'tool, network, file, approval, output-format, or scope constraints',
    );
    expect(instruction).toContain(
      'report the conflict instead of assuming permission',
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
      () => withRunContext(parentRunContext(), () => callDelegateReview()),
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

  it('tells orchestrators that delegations run asynchronously and support parallel dispatch', () => {
    const description = new DelegateAgentTool().definition.description;

    expect(description).toContain('Delegations run asynchronously');
    expect(description).toContain('launch them all in one turn');
    expect(description).toContain(
      'arrives automatically as a follow-up message',
    );
  });

  it('formats returned child error results as subagent errors', async () => {
    const recordSubagentCost = vi.fn();
    mockExecuteAgentErrorOnce(0.42);

    const result = await withToolFileInteractionContext(
      { tracker: {} as never, hooks: { recordSubagentCost } },
      () =>
        withRunContext(parentRunContext({ stopAfterCycle: true }), () =>
          callDelegateReview(),
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
    expect(mocks.writeResultMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ cost: 0.42, outcome: 'failed' }),
      }),
    );
  });

  it('rolls up failed async subagent cost from the error callback', async () => {
    const recordSubagentCost = vi.fn();
    mockExecuteAgentErrorOnce(0.31);

    const result = await withToolFileInteractionContext(
      { tracker: {} as never, hooks: { recordSubagentCost } },
      () => withRunContext(parentRunContext(), () => callDelegateReview()),
    );

    expect(result.summary).toBe("Launched 'review' (async)");
    await vi.waitFor(() => {
      expect(recordSubagentCost).toHaveBeenCalledTimes(1);
    });
    expect(recordSubagentCost).toHaveBeenCalledWith(0.31);
  });

  it('composes interactive delegation through the same native launch primitive', async () => {
    const result = await withRunContext(parentRunContext(), () =>
      callDelegateReview(),
    );

    expect(result.summary).toBe("Launched 'review' (async)");
    expect(result.output).toContain(
      "Subagent 'review' launched. Result will be delivered automatically",
    );
    const executeOptions = mocks.executeAgent.mock.calls.at(-1)?.[2];
    expect(executeOptions).toEqual(
      expect.objectContaining({
        allowWaitingResult: true,
        onRun: expect.any(Function),
        session: expect.any(Object),
      }),
    );
    expect(executeOptions).not.toEqual(
      expect.objectContaining({ stopAfterCycle: true }),
    );
  });

  it('discourages equivalent delegation retries after a no-feedback rejection', async () => {
    const result = await delegateWithProposalDecision({ action: 'reject' });

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
    // Only deepseekT is available (see beforeEach); gpt5 is not, so the
    // override must be rejected synchronously, mirroring the initial delegate
    // path's availability gate.
    const result = await delegateWithProposalDecision({
      action: 'approve',
      model: 'gpt5',
    });

    expect(result.status).toBe('error');
    expect(result.summary).toBe(
      "Approved model override 'gpt5' is not available",
    );
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it('launches with an approved model override that is available', async () => {
    mocks.computeModelOptionsData.mockResolvedValue([
      {
        value: 'deepseekT',
        label: 'DeepSeek',
        disabled: false,
        requiresKey: false,
      },
      { value: 'gpt5', label: 'GPT-5', disabled: false, requiresKey: false },
    ]);

    const result = await delegateWithProposalDecision({
      action: 'approve',
      model: 'gpt5',
    });

    expect(result.status).toBe('executed');
    expect(result.summary).toBe("Launched 'review' (async)");
    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt5' }),
      expect.any(String),
      expect.anything(),
    );
  });

  it('includes memory misses in interactive early-delivered reports', async () => {
    // The mocked `executeAgent` is the child-run loop's `launch` turn, and the
    // WAITING result it returns is what the loop's single delivery site sees.
    mockWaitingChildOnce({
      memoryMisses: [
        { path: '/memories/missing.md', reason: 'not found & unreadable' },
      ],
    });

    await withRunContext(parentRunContext({ streamId: PARENT_STREAM_ID }), () =>
      callDelegateReview(),
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
    let capturedHandle: AgentExecutionHandle | undefined;

    mockWaitingChildOnce({
      // Detach happens between the loop capturing the handle (onRun) and the
      // loop delivering this turn's result (after the mock resolves) — the
      // same ordering a real stop-with-detach produces mid-turn.
      afterRun: (handle) => {
        capturedHandle = handle;
        defaultSession().executions.detachActiveChildren(PARENT_STREAM_ID);
      },
    });

    await withRunContext(parentRunContext({ streamId: PARENT_STREAM_ID }), () =>
      callDelegateReview(),
    );

    await vi.waitFor(() => {
      expect(mocks.writeReport).toHaveBeenCalledWith(
        expect.stringContaining('The proof is correct.'),
      );
    });
    expect(capturedHandle?.deliveryTargetStreamId).toBeUndefined();
    expect(defaultSession().followUps.getAll(PARENT_STREAM_ID)).toEqual([]);
    expect(defaultSession().followUps.getAll(CHILD_STREAM_ID)).toEqual([]);
  });
});
