// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { Effect } from 'effect';
import { it as effectIt } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRunContext,
  withRunContext,
  type RunContext,
} from '@agent/runtime/RunContext';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import type { RunHandle } from '@agent/runtime/RunHandle';
import type {
  HostInteractions,
  ProposalResult,
} from '@agent/runtime/HostInteractions';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import { RunLeaseLostError } from '@agent/storage/runLease';
import {
  RUN_PHASE,
  AgentCategory,
  agentMatchesIdentifier,
} from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { createTestSession } from '@test/support/sessionTestUtils';
import { DelegateAgentTool } from '@tools/delegation/DelegationTools';
import { executeStableSubagentInBand as executeStableSubagentInBandEffect } from '@tools/delegation/inBandSubagentRun';
import { SubagentDurabilityError } from '@tools/delegation/stableSubagentAttempt';
import { provideAgentEngine } from '@tools/delegation/nativeSubagentStrategy';
import { ensureError } from '@utils/errors/errorMessage';

/** Drive the native operation at the test entry point. */
function executeStableSubagentInBand(
  options: Parameters<typeof executeStableSubagentInBandEffect>[0],
) {
  return Effect.runPromise(executeStableSubagentInBandEffect(options));
}

const mocks = vi.hoisted(() => ({
  configureDelegatedChildApprovals: vi.fn(),
  executeAgent: vi.fn(),
  prepareAgentDefinition: vi.fn(),
  resumeToolUseTurn: vi.fn(),
  getRunStore: vi.fn(),
  getVisibleAgents: vi.fn(),
  inspectRunLease: vi.fn(),
  isApprovalBypassedForRun: vi.fn(),
  isProposalBypassed: vi.fn(),
  registerRun: vi.fn(),
  releaseOwnedRunLease: vi.fn(),
  writeReport: vi.fn(),
  writeResultMeta: vi.fn(),
  computeModelOptionsData: vi.fn(),
}));

vi.mock('@agent/runtime/AgentLaunchContext', () => ({
  prepareAgentDefinition: mocks.prepareAgentDefinition,
}));

// Delegation resolves targets through the scope resolver; with no active run
// scope that is the workspace-visible roster, and identity matching is
// agentRegistry's own rule — mirrored here rather than re-implemented.
vi.mock('@agent/index/agentRegistry', () => ({
  getVisibleAgents: mocks.getVisibleAgents,
  resolveDelegationScopeAgents: (scope: unknown, category: AgentCategory) =>
    scope ? [] : mocks.getVisibleAgents(category),
  findAgentByIdentifier: (
    entries: readonly { source: string; name: string }[],
    identifier: string,
  ) => entries.find((entry) => agentMatchesIdentifier(entry, identifier)),
}));

vi.mock('@agent/storage', () => ({
  getRunStore: mocks.getRunStore,
  getRunRecords: (_session: unknown, runId: RunId) => ({
    readMeta: () =>
      Effect.tryPromise({
        try: () => mocks.getRunStore(runId).readMeta(),
        catch: ensureError,
      }),
    readResultMeta: () =>
      Effect.tryPromise({
        try: () => mocks.getRunStore(runId).readResultMeta(),
        catch: ensureError,
      }),
  }),
  registerRun: mocks.registerRun,
}));

// The launch sites register through `registerRun`; route the spy through it.
vi.mock('@agent/storage/runLifecycle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/storage/runLifecycle')>();
  return {
    ...actual,
    registerRun: mocks.registerRun,
  };
});

vi.mock('@agent/storage/runLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/runLease')>()),
  assertOwnedRunLease: vi.fn(),
  inspectRunLease: mocks.inspectRunLease,
  ownsRunLease: vi.fn(() => true),
  // The session's one exit choreography runs for real over these inert lease
  // verbs.
  validateOwnedRunLease: vi.fn(async () => {}),
  releaseOwnedRunLease: mocks.releaseOwnedRunLease,
}));

vi.mock('@agent/storage/childRunDeliveryPersistence', () => ({
  persistChildRunDelivery: (
    _session: unknown,
    runId: RunId,
    message: string,
    resultMeta: unknown,
  ) =>
    Effect.tryPromise({
      try: async () => {
        await mocks.getRunStore(runId).writeReport(message);
        if (resultMeta !== undefined)
          await mocks.getRunStore(runId).writeResultMeta(resultMeta);
      },
      catch: ensureError,
    }),
}));

vi.mock('@model/computeModelOptions', () => ({
  computeModelOptionsData: mocks.computeModelOptionsData,
}));

vi.mock('@tools/approval', () => ({
  configureDelegatedChildApprovals: mocks.configureDelegatedChildApprovals,
  isApprovalBypassedForRun: mocks.isApprovalBypassedForRun,
  proposalApprovals: () => ({
    isBypassed: mocks.isProposalBypassed,
  }),
}));

const PARENT_RUN_ID = 'aaaaaa222222' as RunId;
const CHILD_RUN_ID = 'bbbbbb333333' as RunId;

/** The run context shared by nearly every case (run/stopAfterCycle/session vary). */
function parentRunContext(
  overrides: Partial<{
    runId: RunId;
    stopAfterCycle: boolean;
    session: SessionHandle;
    approvalPromptsUnavailable: boolean;
  }> = {},
): RunContext {
  return createRunContext({
    runId: PARENT_RUN_ID,
    modelCell: { modelId: 'deepseekT' },
    session: defaultSession(),
    ...overrides,
  });
}

/** The shared delegation call used by nearly every case. */
function callDelegateReview() {
  return new DelegateAgentTool().call({
    agent: 'review',
    model: null,
    instruction: 'Check the proof.',
    memories: [],
    working_directory: null,
    execution_id: null,
  });
}

/** Await actual child activation release before disposing its test session. */
async function waitForChildren(session: SessionHandle): Promise<void> {
  while (true) {
    const active = session.runs.getActiveIds();
    if (active.length === 0) return;
    await Effect.runPromise(session.runs.waitForAnyChange(active));
  }
}

/** The same delegation routed through the host's proposal port, with the host
 *  fake answering `decision`. The session owns the fake port, so it is created
 *  and disposed per case. */
async function delegateWithProposalDecision(decision: ProposalResult) {
  mocks.isProposalBypassed.mockReturnValue(false);
  const session = createTestSession();
  session.interactions.use({
    cancel: vi.fn(),
    requestAgentProposal: vi.fn().mockResolvedValue(decision),
  } satisfies HostInteractions);
  try {
    const result = await withRunContext(parentRunContext({ session }), () =>
      callDelegateReview(),
    );
    await waitForChildren(session);
    return result;
  } finally {
    session.dispose();
  }
}

const STABLE_PARENT_RUN_ID = 'abcdef123456' as RunId;
const IN_BAND_LOGICAL_RUN_ID = 'aaaaaa111111' as RunId;

type PreparedInBandSubagentOptions = Effect.Success<
  ReturnType<Parameters<typeof executeStableSubagentInBand>[0]['prepare']>
>;
type InBandSubagentRunOptions = PreparedInBandSubagentOptions & {
  signal?: AbortSignal;
};

/** The in-band delegation options shared by nearly every case (fields vary). */
function delegationOptions(
  overrides: Partial<InBandSubagentRunOptions> = {},
): InBandSubagentRunOptions {
  return {
    configPayload: {
      agent: 'review',
      agentCategory: AgentCategory.ToolUse,
      model: 'deepseekT',
    },
    agentName: 'review',
    parentRunId: STABLE_PARENT_RUN_ID,
    session: defaultSession(),
    ...overrides,
  };
}

/** Run the typed required-result path the way production callers reach it. */
function runInBand(
  options: InBandSubagentRunOptions,
  runId: RunId = IN_BAND_LOGICAL_RUN_ID,
) {
  const { signal, ...prepared } = options;
  return executeStableSubagentInBand({
    runId,
    parentRunId: prepared.parentRunId,
    session: prepared.session,
    signal,
    prepare: () => Effect.succeed(prepared),
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
      outcome: 'failed',
      runId: CHILD_RUN_ID,
      usage: { totalCost: totalCostUsd },
      output: { category: 'toolUse', response: '', files: [] },
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
    afterRun?: (handle: RunHandle) => void;
  } = {},
): void {
  mocks.executeAgent.mockImplementationOnce(
    async (_config, runId: RunId, runOptions) => {
      const handle = testRunHandle({
        runId,
        parent: PARENT_RUN_ID,
        agent: 'review',
      });
      defaultSession().runs.track(handle);
      runOptions.onRunResolved?.(runId);
      runOptions.onRun?.(handle);
      options.afterRun?.(handle);
      return {
        outcome: RUN_PHASE.WAITING,
        output: {
          category: 'toolUse',
          response: 'The proof is correct.',
          files: [],
        },
        runId,
        ...(options.memoryMisses ? { memoryMisses: options.memoryMisses } : {}),
      };
    },
  );
}

function stableAttempt(
  logicalRunId: RunId,
  phase: 'reserved' | 'launched' | 'committed' | 'retryable' = 'launched',
) {
  return {
    schemaVersion: 1,
    logicalRunId,
    parentRunId: STABLE_PARENT_RUN_ID,
    phase,
  } as const;
}

/** In-memory run KV store: enough surface for the stable attempt path. */
function memoryRunStore() {
  const kv = new Map<string, unknown>();
  // The loop persists the manifest and the awaiting caller verifies it by
  // read-back, so the fixture must retain writes like the real store does.
  let resultMeta: unknown = null;
  return {
    listKeys: vi.fn(async () => [...kv.keys()]),
    read: vi.fn(async (key: string) => kv.get(key)),
    write: vi.fn(async (key: string, value: unknown) => {
      kv.set(key, value);
    }),
    readMeta: vi.fn(async () => null),
    readResultMeta: vi.fn(async () => resultMeta),
    writeReport: mocks.writeReport,
    writeResultMeta: vi.fn(async (value: unknown) => {
      // Retain only writes that succeed, like the real store: a rejected
      // write must stay invisible to the caller's durability read-back.
      const written = await mocks.writeResultMeta(value);
      resultMeta = value;
      return written;
    }),
  };
}

/** Child store with nothing persisted: what a fresh attempt starts from. */
function emptyChildStore() {
  return memoryRunStore();
}

/** Child store holding a launched attempt marker and its result manifest. */
function completedChildStore(logicalRunId: RunId, result: unknown) {
  return {
    listKeys: vi
      .fn()
      .mockResolvedValue(['stable-subagent-attempt', 'result-meta']),
    read: vi.fn().mockResolvedValue(stableAttempt(logicalRunId, 'committed')),
    readMeta: vi.fn(async () => null),
    readResultMeta: vi.fn().mockResolvedValue({
      producer: 'subagent',
      agentName: 'review',
      wallTimeMs: 100,
      result,
    }),
  };
}

/** Route parent reads to the sequence store and every child read elsewhere. */
function useStableStores(sequenceStore: unknown, childStore: unknown): void {
  mocks.getRunStore.mockImplementation((runId: RunId) =>
    runId === STABLE_PARENT_RUN_ID ? sequenceStore : childStore,
  );
}

function stableSequenceStore(logicalRunId: RunId, nextAttempt = 0) {
  let sequence =
    nextAttempt === 0
      ? undefined
      : {
          schemaVersion: 1 as const,
          logicalRunId,
          parentRunId: STABLE_PARENT_RUN_ID,
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
  let restoreAgentEngine = (): void => {};

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareAgentDefinition.mockImplementation(
      ({ config }: { config: unknown }) =>
        Effect.succeed({ config, setting: { defaultOutputFiles: [] } }),
    );
    mocks.registerRun.mockReturnValue(Effect.void);
    mocks.releaseOwnedRunLease.mockResolvedValue(undefined);
    restoreAgentEngine = provideAgentEngine({
      executeAgent: (...args) =>
        Effect.tryPromise({
          try: () => mocks.executeAgent(...args),
          catch: ensureError,
        }),
      resumeToolUseTurn: (...args) =>
        Effect.tryPromise({
          try: () => mocks.resumeToolUseTurn(...args),
          catch: ensureError,
        }),
    });
    mocks.getVisibleAgents.mockReturnValue([
      {
        name: 'review',
        source: 'builtInToolUse',
        description: 'Review work.',
        tools: [],
      },
    ]);
    mocks.computeModelOptionsData.mockResolvedValue([
      {
        value: 'deepseekT',
        label: 'DeepSeek',
        disabled: false,
        requiresKey: false,
      },
    ]);
    mocks.isProposalBypassed.mockReturnValue(true);
    mocks.isApprovalBypassedForRun.mockReturnValue(false);
    mocks.inspectRunLease.mockResolvedValue({ status: 'free' });
    const memoryStores = new Map<RunId, ReturnType<typeof memoryRunStore>>();
    mocks.getRunStore.mockImplementation((runId: RunId) => {
      let store = memoryStores.get(runId);
      if (!store) {
        store = memoryRunStore();
        memoryStores.set(runId, store);
      }
      return store;
    });
    mocks.executeAgent.mockResolvedValue({
      outcome: 'completed',
      runId: CHILD_RUN_ID,
      output: {
        category: 'toolUse',
        response: 'The proof is correct.',
        files: [],
      },
    });
  });

  effectIt.effect(
    'validates workflow inputs against its once-loaded definition before registration',
    () =>
      Effect.gen(function* () {
        const setting = {
          defaultOutputFiles: [] as string[],
          tools: ['read_file'],
        };
        mocks.prepareAgentDefinition.mockImplementation(
          ({ config }: { config: unknown }) =>
            Effect.succeed({ config, setting }),
        );
        const options = delegationOptions({
          configPayload: {
            agent: 'review',
            agentSource: 'remote',
            agentCategory: AgentCategory.Workflow,
            model: 'deepseekT',
          },
        });
        const { signal, ...prepared } = options;
        const run = () =>
          executeStableSubagentInBandEffect({
            runId: IN_BAND_LOGICAL_RUN_ID,
            parentRunId: prepared.parentRunId,
            session: prepared.session,
            signal,
            prepare: () => Effect.succeed(prepared),
          });
        expect(yield* Effect.flip(run())).toMatchObject({
          name: 'WorkflowRunAbortError',
          message: expect.stringContaining('pass options.inputFiles'),
        });
        expect(mocks.registerRun).not.toHaveBeenCalled();
        setting.defaultOutputFiles = ['generated.tex'];
        mocks.prepareAgentDefinition.mockClear();
        mocks.executeAgent.mockResolvedValue({
          outcome: 'completed',
          output: {
            category: 'workflow',
            outputs: [],
            compileFailures: [],
            diffs: [],
          },
        });
        yield* run();
        expect(mocks.prepareAgentDefinition).toHaveBeenCalledOnce();
        expect(mocks.executeAgent).toHaveBeenCalledWith(
          expect.objectContaining({ setting }),
          expect.any(String),
          expect.any(Object),
        );
      }),
  );

  afterEach(async () => {
    const session = defaultSession();
    for (const runId of session.runs.getActiveIds()) {
      // Test handles have no provider interrupt handler. Remove the fake
      // handle, then stop the real child activation that owns the loop.
      session.runs.untrack(runId);
      await Effect.runPromise(session.runs.kill(runId).settlement);
    }
    session.followUps.terminalize(PARENT_RUN_ID);
    session.followUps.terminalize(CHILD_RUN_ID);
    await waitForChildren(session);
    restoreAgentEngine();
  });

  it('awaits child delegation during one-shot tool-use runs', async () => {
    const result = await withRunContext(
      parentRunContext({ stopAfterCycle: true }),
      () => callDelegateReview(),
    );

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          agent: 'review',
          agentCategory: AgentCategory.ToolUse,
          instruction: expect.stringContaining('Check the proof.'),
          model: 'deepseekT',
        }),
      }),
      expect.any(String),
      expect.objectContaining({
        parentRunId: PARENT_RUN_ID,
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

  it('composes durable workflow calls through the native launch primitive', async () => {
    const result = await runInBand(
      delegationOptions({ workflowPhase: 'proof-review' }),
    );

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ agent: 'review' }),
      }),
      result.runId,
      expect.objectContaining({
        stopAfterCycle: true,
        workflowPhase: 'proof-review',
      }),
    );
    expect(result.result).toEqual({
      outcome: 'completed',
      output: {
        category: 'toolUse',
        response: 'The proof is correct.',
        files: [],
      },
    });
    // The single driver persists the report alongside the manifest for every
    // child — a scripted grandchild is debuggable through the same artifacts
    // as any detached child (this closed item 10's report gap).
    expect(mocks.writeReport).toHaveBeenCalled();
    expect(mocks.registerRun).toHaveBeenCalledWith(
      defaultSession(),
      result.runId,
      expect.objectContaining({ agent: 'review' }),
      'review',
      expect.objectContaining({ parentRunId: STABLE_PARENT_RUN_ID }),
    );
    expect(mocks.writeResultMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        producer: 'subagent',
        agentName: 'review',
        wallTimeMs: expect.any(Number),
        // The loop stamps turn attribution on every manifest it persists —
        // scripted children included (this closed item 10's turnToken gap).
        turnToken: expect.any(String),
        result: result.result,
      }),
    );
    expect(mocks.writeResultMeta.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.releaseOwnedRunLease.mock.invocationCallOrder[0],
    );
  });

  it('commits stable success after artifact drain but before lease release', async () => {
    const logicalRunId = 'cccccc666666' as RunId;
    const childStore = memoryRunStore();
    const order: string[] = [];
    const originalWrite = childStore.write.getMockImplementation();
    childStore.write.mockImplementation(async (key, value) => {
      await originalWrite?.(key, value);
      const phase = (value as { phase?: string }).phase;
      if (phase) order.push(phase);
    });
    const session = defaultSession();
    const settle = session.flushArtifacts.bind(session);
    const drain = vi
      .spyOn(session, 'flushArtifacts')
      .mockImplementation(async () => {
        order.push('drain');
        await settle();
      });
    mocks.releaseOwnedRunLease.mockImplementationOnce(async () => {
      order.push('release');
    });
    useStableStores(stableSequenceStore(logicalRunId), childStore);

    try {
      await runInBand(delegationOptions(), logicalRunId);
    } finally {
      drain.mockRestore();
    }

    expect(order).toContain('launched');
    expect(order.lastIndexOf('drain')).toBeLessThan(order.indexOf('committed'));
    expect(order.indexOf('committed')).toBeLessThan(order.indexOf('release'));
    expect(mocks.releaseOwnedRunLease).toHaveBeenCalledOnce();
  });

  it('releases the lease even when the post-drain stable commit fails', async () => {
    const logicalRunId = 'cccccc777777' as RunId;
    const childStore = memoryRunStore();
    const commitError = new Error('commit write failed');
    const originalWrite = childStore.write.getMockImplementation();
    childStore.write.mockImplementation(async (key, value) => {
      if ((value as { phase?: string }).phase === 'committed') {
        throw commitError;
      }
      await originalWrite?.(key, value);
    });
    useStableStores(stableSequenceStore(logicalRunId), childStore);

    await expect(
      runInBand(delegationOptions(), logicalRunId),
    ).rejects.toMatchObject({
      name: 'SubagentCommitError',
      message: expect.stringContaining('Failed to commit durable completion'),
      cause: commitError,
    });

    expect(mocks.releaseOwnedRunLease).toHaveBeenCalledWith(logicalRunId);
    expect(childStore.write).toHaveBeenCalledWith(
      'stable-subagent-attempt',
      expect.objectContaining({ phase: 'launched' }),
    );
    expect(childStore.write).not.toHaveBeenCalledWith(
      'stable-subagent-attempt',
      expect.objectContaining({ phase: 'retryable' }),
    );
  });

  it('recovers committed success when lease deletion fails', async () => {
    const logicalRunId = 'cccccc999999' as RunId;
    const childStore = memoryRunStore();
    const releaseError = new Error('lease deletion failed');
    useStableStores(stableSequenceStore(logicalRunId), childStore);
    mocks.releaseOwnedRunLease.mockRejectedValueOnce(releaseError);

    await expect(
      runInBand(delegationOptions(), logicalRunId),
    ).rejects.toMatchObject({
      name: 'SubagentDurabilityError',
      message: expect.stringContaining('committed durable completion'),
      cause: releaseError,
    });
    await expect(
      runInBand(delegationOptions(), logicalRunId),
    ).resolves.toMatchObject({ runId: logicalRunId });

    expect(mocks.executeAgent).toHaveBeenCalledOnce();
    expect(childStore.write).toHaveBeenCalledWith(
      'stable-subagent-attempt',
      expect.objectContaining({ phase: 'committed' }),
    );
    expect(childStore.write).not.toHaveBeenCalledWith(
      'stable-subagent-attempt',
      expect.objectContaining({ phase: 'retryable' }),
    );
  });

  it('records a failed child cost once for durable in-band run', async () => {
    const onCost = vi.fn();
    mockExecuteAgentErrorOnce(0.61, {
      runId: IN_BAND_LOGICAL_RUN_ID,
      output: {
        category: 'toolUse',
        response: 'Partial review.',
        files: [],
      },
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
          outcome: 'failed',
          usage: expect.objectContaining({ totalCost: 0.61 }),
          output: expect.objectContaining({ response: 'Partial review.' }),
        }),
      }),
    );
  });

  it('persists a cost-bearing WAITING result as a durable single-cycle failure', async () => {
    const onCost = vi.fn();
    mocks.executeAgent.mockResolvedValueOnce({
      outcome: RUN_PHASE.WAITING,
      runId: IN_BAND_LOGICAL_RUN_ID,
      output: {
        category: 'toolUse',
        response: 'Waiting for clarification.',
        files: [],
      },
      usage: { totalCost: 0.73 },
    });

    await expect(runInBand(delegationOptions({ onCost }))).rejects.toThrow(
      `Single-cycle subagent ${IN_BAND_LOGICAL_RUN_ID} unexpectedly suspended.`,
    );

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.any(Object),
      IN_BAND_LOGICAL_RUN_ID,
      expect.objectContaining({
        parentRunId: STABLE_PARENT_RUN_ID,
        stopAfterCycle: true,
      }),
    );
    expect(onCost).toHaveBeenCalledOnce();
    expect(onCost).toHaveBeenCalledWith(0.73);
    expect(mocks.writeResultMeta).toHaveBeenCalledOnce();
    expect(mocks.writeResultMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          outcome: 'failed',
          usage: expect.objectContaining({ totalCost: 0.73 }),
          output: expect.objectContaining({
            response: 'Waiting for clarification.',
          }),
        }),
      }),
    );
  });

  it('recovers a completed stable child before resolving launch prerequisites', async () => {
    const stableRunId = 'cccccc333333' as RunId;
    const persistedResult = {
      outcome: 'completed' as const,
      output: {
        category: 'toolUse' as const,
        response: 'Recovered review.',
        files: [],
      },
    };
    const sequenceStore = stableSequenceStore(stableRunId, 1);
    useStableStores(
      sequenceStore,
      completedChildStore(stableRunId, persistedResult),
    );
    const prepare = vi.fn(() =>
      Effect.fail(new Error('current agent is unavailable')),
    );

    await expect(
      executeStableSubagentInBand({
        runId: stableRunId,
        parentRunId: STABLE_PARENT_RUN_ID,
        session: defaultSession(),
        prepare,
      }),
    ).resolves.toEqual({
      runId: stableRunId,
      result: persistedResult,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(mocks.registerRun).not.toHaveBeenCalled();
    expect(mocks.executeAgent).not.toHaveBeenCalled();
    expect(mocks.writeResultMeta).not.toHaveBeenCalled();
  });

  it('recovers a later completed attempt when an earlier child was deleted', async () => {
    const logicalRunId = 'cccccc444444' as RunId;
    const persistedResult = {
      outcome: 'completed' as const,
      output: {
        category: 'toolUse' as const,
        response: 'Recovered later attempt.',
        files: [],
      },
    };
    const sequenceStore = stableSequenceStore(logicalRunId, 2);
    const missingStore = emptyChildStore();
    const completedStore = completedChildStore(logicalRunId, persistedResult);
    mocks.getRunStore.mockImplementation((runId: RunId) => {
      if (runId === STABLE_PARENT_RUN_ID) return sequenceStore;
      return runId === logicalRunId ? missingStore : completedStore;
    });
    const prepare = vi.fn();

    const recovered = await executeStableSubagentInBand({
      runId: logicalRunId,
      parentRunId: STABLE_PARENT_RUN_ID,
      session: defaultSession(),
      prepare,
    });

    expect(recovered.result).toBe(persistedResult);
    expect(recovered.runId).not.toBe(logicalRunId);
    expect(prepare).not.toHaveBeenCalled();
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it('refuses to repeat a committed child whose result manifest is missing', async () => {
    const logicalRunId = 'cccccc777777' as RunId;
    const sequenceStore = stableSequenceStore(logicalRunId, 1);
    useStableStores(sequenceStore, {
      ...emptyChildStore(),
      listKeys: vi
        .fn()
        .mockResolvedValue(['stable-subagent-attempt', 'config']),
      read: vi.fn().mockResolvedValue(stableAttempt(logicalRunId, 'committed')),
    });

    await expect(
      runInBand(delegationOptions(), logicalRunId),
    ).rejects.toBeInstanceOf(SubagentDurabilityError);
    expect(mocks.registerRun).not.toHaveBeenCalled();
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it('refuses to repeat an incomplete stable child', async () => {
    const logicalRunId = 'dddddd444444' as RunId;
    const sequenceStore = stableSequenceStore(logicalRunId, 1);
    useStableStores(sequenceStore, {
      ...emptyChildStore(),
      listKeys: vi.fn().mockResolvedValue(['meta']),
    });

    await expect(
      runInBand(delegationOptions(), logicalRunId),
    ).rejects.toBeInstanceOf(SubagentDurabilityError);
    expect(mocks.registerRun).not.toHaveBeenCalled();
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it.each(['reserved', 'retryable'] as const)(
    'retries a %s child without a result manifest',
    async (phase) => {
      const logicalRunId = 'dddddd555555' as RunId;
      const stores = new Map<RunId, Record<string, unknown>>();
      const sequenceStore = stableSequenceStore(logicalRunId, 1);
      mocks.getRunStore.mockImplementation((id: RunId) => {
        if (id === STABLE_PARENT_RUN_ID) return sequenceStore;
        let store = stores.get(id);
        if (store) return store;
        store =
          id === logicalRunId
            ? {
                ...emptyChildStore(),
                listKeys: vi
                  .fn()
                  .mockResolvedValue(['stable-subagent-attempt', 'config']),
                read: vi
                  .fn()
                  .mockResolvedValue(stableAttempt(logicalRunId, phase)),
              }
            : emptyChildStore();
        stores.set(id, store);
        return store;
      });

      const completed = await runInBand(delegationOptions(), logicalRunId);

      expect(completed.runId).not.toBe(logicalRunId);
      expect(mocks.executeAgent).toHaveBeenCalledOnce();
    },
  );

  it('refuses to repeat a completed stable child when its manifest cannot be written', async () => {
    const logicalRunId = 'dddddd666666' as RunId;
    const sequenceStore = stableSequenceStore(logicalRunId);
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

    await expect(runInBand(options, logicalRunId)).rejects.toBeInstanceOf(
      SubagentDurabilityError,
    );

    expect(write).toHaveBeenLastCalledWith(
      'stable-subagent-attempt',
      expect.objectContaining({ phase: 'launched' }),
    );
    await expect(runInBand(options, logicalRunId)).rejects.toBeInstanceOf(
      SubagentDurabilityError,
    );
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
  });

  it('uses a new durable attempt after failed and cancelled children', async () => {
    const logicalRunId = 'eeeeee555555' as RunId;
    const stores = new Map<RunId, Record<string, unknown>>();
    const sequenceStore = stableSequenceStore(logicalRunId);
    const priorOutcomes = ['failed', 'cancelled'] as const;
    mocks.getRunStore.mockImplementation((id: RunId) => {
      if (id === STABLE_PARENT_RUN_ID) return sequenceStore;
      let store = stores.get(id);
      if (store) return store;
      const priorOutcome = priorOutcomes[stores.size];
      store = priorOutcome
        ? completedChildStore(logicalRunId, {
            outcome: priorOutcome,
            output: { category: 'toolUse', response: '', files: [] },
          })
        : emptyChildStore();
      stores.set(id, store);
      return store;
    });

    const completed = await runInBand(delegationOptions(), logicalRunId);

    expect(completed.runId).not.toBe(logicalRunId);
    expect(stores.size).toBe(3);
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
    expect(mocks.registerRun).toHaveBeenCalledWith(
      defaultSession(),
      completed.runId,
      expect.anything(),
      'review',
      expect.objectContaining({ parentRunId: STABLE_PARENT_RUN_ID }),
    );
  });

  it('does not commit a cancelled stable child as successful', async () => {
    const logicalRunId = 'eeeeee666666' as RunId;
    const childStore = memoryRunStore();
    useStableStores(stableSequenceStore(logicalRunId), childStore);
    mocks.executeAgent.mockResolvedValueOnce({
      outcome: 'cancelled',
      runId: logicalRunId,
      output: { category: 'toolUse', response: '', files: [] },
    });

    const completed = await runInBand(delegationOptions(), logicalRunId);

    expect(completed.result.outcome).toBe('cancelled');
    expect(childStore.write).not.toHaveBeenCalledWith(
      'stable-subagent-attempt',
      expect.objectContaining({ phase: 'committed' }),
    );
  });

  it('does not return a typed result when its durable manifest cannot be written', async () => {
    mocks.writeResultMeta.mockRejectedValueOnce(new Error('storage offline'));

    await expect(runInBand(delegationOptions())).rejects.toBeInstanceOf(
      SubagentDurabilityError,
    );
    // The single driver persists the report independently of the manifest;
    // the manifest read-back is what gates the typed return.
    expect(mocks.writeReport).toHaveBeenCalled();
  });

  it('preserves the child failure when final lease cleanup also fails', async () => {
    const childFailure = new Error('review model failed');
    mocks.executeAgent.mockRejectedValueOnce(childFailure);
    mocks.releaseOwnedRunLease.mockRejectedValueOnce(
      new Error('artifact flush failed'),
    );

    await expect(runInBand(delegationOptions())).rejects.toBe(childFailure);
  });

  it('does not recover a typed result after failed artifact cleanup', async () => {
    const cleanupFailure = new Error('artifact flush failed');
    const logicalRunId = 'dddddd777777' as RunId;
    const childStore = memoryRunStore();
    const write = childStore.write.getMockImplementation();
    childStore.write.mockImplementation(async (key, value) => {
      if (
        key === 'stable-subagent-attempt' &&
        (value as { phase?: string }).phase === 'retryable'
      ) {
        throw new RunLeaseLostError(logicalRunId);
      }
      return await write?.(key, value);
    });
    useStableStores(stableSequenceStore(logicalRunId), childStore);
    const cleanup = vi
      .spyOn(defaultSession(), 'flushArtifacts')
      .mockRejectedValue(cleanupFailure);

    try {
      await expect(
        runInBand(delegationOptions(), logicalRunId),
      ).rejects.toMatchObject({
        name: 'SubagentDurabilityError',
        cause: cleanupFailure,
      });
    } finally {
      cleanup.mockRestore();
    }
    mocks.inspectRunLease.mockResolvedValueOnce({
      status: 'held',
      owner: { pid: 1, processStart: '1', hostname: 'test-host' },
    });

    await expect(
      runInBand(delegationOptions(), logicalRunId),
    ).rejects.toBeInstanceOf(SubagentDurabilityError);
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
  });

  it('does not recover a completed manifest after restart repair removes an abandoned lease', async () => {
    const cleanupFailure = new Error('artifact flush failed');
    const logicalRunId = 'dddddd888888' as RunId;
    const childStore = memoryRunStore();
    const write = childStore.write.getMockImplementation();
    let abandonedLeasePresent = true;
    childStore.write.mockImplementation(async (key, value) => {
      if (
        abandonedLeasePresent &&
        key === 'stable-subagent-attempt' &&
        (value as { phase?: string }).phase === 'retryable'
      ) {
        throw new RunLeaseLostError(logicalRunId);
      }
      return await write?.(key, value);
    });
    useStableStores(stableSequenceStore(logicalRunId), childStore);
    const cleanup = vi
      .spyOn(defaultSession(), 'flushArtifacts')
      .mockRejectedValue(cleanupFailure);

    try {
      await expect(
        runInBand(delegationOptions(), logicalRunId),
      ).rejects.toMatchObject({
        name: 'SubagentDurabilityError',
        cause: cleanupFailure,
      });
    } finally {
      cleanup.mockRestore();
    }

    // Perform the restart repair's observable lease transition before the
    // stable call resumes: the abandoned lease no longer fences store writes.
    // That absence must not attest artifact-release success; only the explicit
    // post-drain commit marker can do that.
    abandonedLeasePresent = false;
    await expect(
      runInBand(delegationOptions(), logicalRunId),
    ).rejects.toBeInstanceOf(SubagentDurabilityError);
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
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
        outcome: 'failed',
        runId: CHILD_RUN_ID,
        output: { category: 'toolUse', response: '', files: [42] },
      } as never;
      await options.onRunError?.(new Error('review model failed'), failed);
      return failed;
    });

    const run = runInBand(delegationOptions());

    // An unconstructable failure result degrades to the category-only
    // manifest carrying the child's real error, so durability holds and the
    // caller sees the child failure itself.
    await expect(run).rejects.toThrow('review model failed');
    expect(mocks.writeResultMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          outcome: 'failed',
          error: expect.objectContaining({ message: 'review model failed' }),
        }),
      }),
    );
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
        outcome: 'cancelled',
        runId: CHILD_RUN_ID,
        output: { category: 'toolUse', response: '', files: [] },
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
    expect(mocks.registerRun).not.toHaveBeenCalled();
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it('carries the validated agent source to executeAgent for source-pinned launch', async () => {
    // The delegation validates against the visible roster and must hand the
    // resolved entry's source to executeAgent, so getAgentPath resolves the exact
    // (source, name) key instead of re-resolving the ambiguous bare name.
    await withRunContext(parentRunContext({ stopAfterCycle: true }), () =>
      callDelegateReview(),
    );

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          agent: 'review',
          agentSource: 'builtInToolUse',
        }),
      }),
      expect.any(String),
      expect.anything(),
    );
  });

  it('extends the bare instruction with injected handoff guidance', async () => {
    // Regression pin for #5864: delegation must inject handoff guidance rather
    // than hand the caller's instruction through verbatim. Deliberately
    // wording-free — the injected copy churns (#9568) without behavior changing.
    await withRunContext(parentRunContext(), () => callDelegateReview());
    await waitForChildren(defaultSession());

    const instruction =
      mocks.executeAgent.mock.calls.at(-1)?.[0].config.instruction;
    expect(instruction).toContain('Check the proof.');
    expect(instruction.length).toBeGreaterThan('Check the proof.'.length);
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
    await waitForChildren(defaultSession());

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          rootUserInstruction: parentInstruction,
          instruction: expect.stringContaining(
            `Parent user request (constraint context only):\n${parentInstruction}`,
          ),
        }),
      }),
      expect.any(String),
      expect.anything(),
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
        result: expect.objectContaining({
          outcome: 'failed',
          usage: expect.objectContaining({ totalCost: 0.42 }),
        }),
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
    await waitForChildren(defaultSession());
    const executeOptions = mocks.executeAgent.mock.calls.at(-1)?.[2];
    expect(executeOptions).toEqual(
      expect.objectContaining({
        parentRunId: PARENT_RUN_ID,
        onRun: expect.any(Function),
        session: expect.any(Object),
      }),
    );
    expect(executeOptions).not.toEqual(
      expect.objectContaining({ stopAfterCycle: true }),
    );
  });

  it('does not attribute proposal cancellation to the user', async () => {
    const result = await delegateWithProposalDecision({
      action: 'reject',
      cause: 'CLI approval prompt failed.',
    });

    expect(result.summary).toBe("Delegation approval cancelled for 'review'");
    expect(result.error).toContain('CLI approval prompt failed.');
    expect(result.error).not.toContain('User feedback:');
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it('proceeds without a proposal when the run cannot present approval prompts', async () => {
    // Headless `--approval-policy never` withholds `requiresApproval` tools up
    // front, so a delegation tool that still executes was deliberately offered
    // (delegate_multi_agents). The proposal gate must not settle a
    // guaranteed denial; the child stays on inherited approval state.
    mocks.isProposalBypassed.mockReturnValue(false);
    const session = createTestSession();
    const requestAgentProposal = vi.fn();
    session.interactions.use({
      cancel: vi.fn(),
      requestAgentProposal,
    } satisfies HostInteractions);
    try {
      const result = await withRunContext(
        parentRunContext({ session, approvalPromptsUnavailable: true }),
        () => callDelegateReview(),
      );

      await waitForChildren(session);
      expect(requestAgentProposal).not.toHaveBeenCalled();
      expect(result.status).toBe('executed');
      expect(result.summary).toBe("Launched 'review' (async)");
      expect(mocks.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ agent: 'review' }),
        }),
        expect.any(String),
        expect.anything(),
      );
    } finally {
      session.dispose();
    }
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
      expect.objectContaining({
        config: expect.objectContaining({ model: 'gpt5' }),
      }),
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

    await withRunContext(parentRunContext({ runId: PARENT_RUN_ID }), () =>
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
    let capturedHandle: RunHandle | undefined;

    mockWaitingChildOnce({
      // Detach happens between the loop capturing the handle (onRun) and the
      // loop delivering this turn's result (after the mock resolves) — the
      // same ordering a real stop-with-detach produces mid-turn.
      afterRun: (handle) => {
        capturedHandle = handle;
        defaultSession().runs.detachActiveChildren(PARENT_RUN_ID);
      },
    });

    await withRunContext(parentRunContext({ runId: PARENT_RUN_ID }), () =>
      callDelegateReview(),
    );

    await vi.waitFor(() => {
      expect(mocks.writeReport).toHaveBeenCalledWith(
        expect.stringContaining('The proof is correct.'),
      );
    });
    expect(capturedHandle?.deliveryTarget).toBeUndefined();
    expect(defaultSession().followUps.getAll(PARENT_RUN_ID)).toEqual([]);
    expect(defaultSession().followUps.getAll(CHILD_RUN_ID)).toEqual([]);
  });
});
