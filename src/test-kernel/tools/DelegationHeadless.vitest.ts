// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { Effect, Fiber, Stream } from 'effect';
import { it as effectIt } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRunContext,
  withRunContext,
  type RunContext,
} from '@agent/runtime/RunContext';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import type { RunHandle } from '@agent/runtime/RunHandle';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  RUN_PHASE,
  AgentCategory,
  agentMatchesIdentifier,
} from '@shared/schemas';
import type {
  RequestDecision,
  RunId,
  StableSubagentPhase,
} from '@shared/schemas';
import { DatabaseWriteFailed } from '@shared/session/database';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { fakeProcessServices } from '@test/support/setupPlatform';
import { DelegateAgentTool } from '@tools/delegation/DelegationTools';
import { executeStableSubagentInBand as executeStableSubagentInBandEffect } from '@tools/delegation/inBandSubagentRun';
import { SubagentDurabilityError } from '@tools/delegation/stableSubagentAttempt';
import { provideAgentEngine } from '@tools/delegation/nativeSubagentStrategy';
import { deriveRunId } from '@utils/core/idHash';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

/** Drive the native operation at the test entry point. */
function executeStableSubagentInBand(
  options: Parameters<typeof executeStableSubagentInBandEffect>[0],
) {
  return Effect.runPromise(
    Effect.provide(
      executeStableSubagentInBandEffect(options),
      fakeProcessServices(),
    ),
  );
}

const mocks = vi.hoisted(() => ({
  configureDelegatedChildApprovals: vi.fn(),
  executeAgent: vi.fn(),
  prepareAgentDefinition: vi.fn(),
  resumeToolUseTurn: vi.fn(),
  childRecords: vi.fn(),
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
  getRunRecords: (_session: unknown, runId: RunId) => ({
    exists: () =>
      Effect.tryPromise({
        try: () => mocks.childRecords(runId).exists(),
        catch: ensureError,
      }),
    readResultMeta: () =>
      Effect.tryPromise({
        try: () => mocks.childRecords(runId).readResultMeta(),
        catch: ensureError,
      }),
    readRunEnd: () =>
      Effect.tryPromise({
        try: () => mocks.childRecords(runId).readRunEnd(),
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
        await mocks.childRecords(runId).writeReport(message);
        if (resultMeta !== undefined)
          await mocks.childRecords(runId).writeResultMeta(resultMeta);
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
    config: { model: 'deepseekT' },
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

/**
 * Answer every request the session opens the way a surface's `request.decide`
 * does — one `request.decided` row on the same run — and record the kinds
 * asked for, so a case can assert that nothing was asked at all.
 */
function answerOpenedRequests(
  session: SessionHandle,
  decision: RequestDecision,
) {
  const openedKinds: string[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(session.events.all(session.now()), (event) =>
      Effect.sync(() => {
        if (event.type !== 'request.opened') return;
        openedKinds.push(event.payload.kind);
        session.publish([
          {
            type: 'request.decided',
            aggregateId: event.aggregateId,
            requestId: event.requestId,
            decision,
          },
        ]);
      }),
    ),
  );
  return {
    openedKinds,
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
}

/** The same delegation routed through the request protocol, with `decision`
 *  answering the proposal the run opens. The session owns the decider, so it
 *  is created and disposed per case. */
async function delegateWithProposalDecision(
  decision: RequestDecision,
  options: { expectLaunch?: boolean } = {},
) {
  mocks.isProposalBypassed.mockReturnValue(false);
  const session = createTestSession();
  // A request is a row on its run, so the parent run must exist first.
  publishTestRunStart(session, PARENT_RUN_ID);
  await session.settlePublications();
  const decider = answerOpenedRequests(session, decision);
  try {
    const result = await withRunContext(parentRunContext({ session }), () =>
      callDelegateReview(),
    );
    // A detached child commits its `child.turn` row before its first turn
    // runs, so the launch is not observable the moment the tool returns and
    // the session must not be disposed out from under it.
    if (options.expectLaunch)
      await vi.waitFor(() => expect(mocks.executeAgent).toHaveBeenCalled());
    await waitForChildren(session);
    return result;
  } finally {
    await decider.stop();
    session.dispose();
  }
}

const STABLE_PARENT_RUN_ID = 'abcdef123456' as RunId;
const IN_BAND_LOGICAL_RUN_ID = 'aaaaaa111111' as RunId;

/**
 * The stable-call session, one per case. The attempt markers are rows on the
 * launching run's aggregate now, so a shared database would let one case read
 * the markers and the child runs another case left behind.
 */
let stableSession: SessionHandle;

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
    session: stableSession,
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

/** The physical attempt's run, spelled the way the protocol derives it. */
function attemptRunId(logicalRunId: RunId, attempt: number): RunId {
  return attempt === 0 ? logicalRunId : deriveRunId({ attempt, logicalRunId });
}

/**
 * Seed the parent-owned rows a previous stable call left: how many physical
 * attempts it reserved, and each attempt's phase. Both live on the launching
 * run's aggregate, keyed inside the payload.
 */
async function seedStableMarkers(
  logicalRunId: RunId,
  nextAttempt: number,
  attempts: ReadonlyArray<{ attempt: number; phase: StableSubagentPhase }> = [],
): Promise<void> {
  const aggregate = aggregateId('run', STABLE_PARENT_RUN_ID);
  stableSession.publish([
    ...(nextAttempt > 0
      ? [
          {
            type: 'run.subagentSequence' as const,
            aggregateId: aggregate,
            logicalRunId,
            nextAttempt,
          },
        ]
      : []),
    ...attempts.map(({ attempt, phase }) => ({
      type: 'run.subagentAttempt' as const,
      aggregateId: aggregate,
      runId: attemptRunId(logicalRunId, attempt),
      logicalRunId,
      phase,
    })),
  ]);
  await stableSession.settlePublications();
}

/**
 * Watch the attempt markers the call publishes, in commit order, and
 * optionally refuse one the way a rejected append does. The markers are rows
 * now, so the session's own commit is where they are observable.
 */
function watchAttemptMarkers(
  order: string[],
  refuse?: (phase: StableSubagentPhase) => boolean,
) {
  const commit = stableSession.commit.bind(stableSession);
  return vi.spyOn(stableSession, 'commit').mockImplementation((events) => {
    for (const event of events) {
      if (event.type !== 'run.subagentAttempt') continue;
      if (refuse?.(event.phase))
        return Effect.fail(
          new DatabaseWriteFailed({
            path: ':memory:',
            cause: new Error(`refused the ${event.phase} marker`),
          }),
        );
      order.push(event.phase);
    }
    return commit(events);
  });
}

/** In-memory child records: enough surface for the stable attempt path. */
function memoryChildRecords() {
  // The loop persists the manifest and the awaiting caller verifies it by
  // read-back, so the fixture must retain writes like the real store does.
  let resultMeta: unknown = null;
  // Stand-in for the `run.end` row: production writes it inside
  // `executeAgent`, which this suite replaces with a mock, so the engine
  // wrapper records the turn's terminal fact here instead.
  let runEnd: unknown = null;
  return {
    // Nothing registered: the run's `run.start` is not in the log.
    exists: vi.fn(async () => false),
    readResultMeta: vi.fn(async () => resultMeta),
    readRunEnd: vi.fn(async () => runEnd),
    recordRunEnd: (value: unknown) => {
      runEnd = value;
    },
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

/**
 * Write the `run.end` fact production's `executeAgent` commits through
 * `runFlowWithLifecycle`: the flow's outcome, usage and output, plus the
 * classified error it reported. A single-cycle WAITING turn is an invariant
 * violation that the same lifecycle ends as FAILED.
 */
function recordTerminalFact(
  runId: RunId,
  turn: unknown,
  reportedError: unknown,
): void {
  const store = mocks.childRecords(runId) as {
    recordRunEnd?: (value: unknown) => void;
  };
  const flow = turn as {
    outcome?: string;
    usage?: unknown;
    output?: unknown;
  } | null;
  if (!store.recordRunEnd || !flow?.outcome) return;
  const outcome = flow.outcome === RUN_PHASE.WAITING ? 'failed' : flow.outcome;
  store.recordRunEnd({
    outcome,
    ...(outcome === 'failed' && reportedError !== undefined
      ? {
          error: {
            kind: 'unexpected',
            message: toErrorMessage(reportedError),
          },
        }
      : {}),
    ...(flow.usage ? { usage: flow.usage } : {}),
    output: flow.output,
  });
}

/** Child records with nothing persisted: what a fresh attempt starts from. */
function emptyChildRecords() {
  return memoryChildRecords();
}

/** Child records for an attempt that ran: its terminal row and manifest. */
function completedChildRecords(runEnd: { outcome: string; output: unknown }) {
  return {
    exists: vi.fn(async () => true),
    readRunEnd: vi.fn().mockResolvedValue(runEnd),
    readResultMeta: vi.fn().mockResolvedValue({
      producer: 'subagent',
      agentName: 'review',
      wallTimeMs: 100,
      output: runEnd.output,
    }),
  };
}

/** Route every child read to one set of records. */
function useChildRecords(childRecords: unknown): void {
  mocks.childRecords.mockImplementation(() => childRecords);
}

describe('headless delegation', () => {
  let restoreAgentEngine = (): void => {};

  beforeEach(async () => {
    vi.clearAllMocks();
    // The stable-attempt markers are rows on the launching run's aggregate,
    // and a run's aggregate must begin with its `run.start`.
    stableSession = createTestSession();
    publishTestRunStart(stableSession, STABLE_PARENT_RUN_ID);
    await stableSession.settlePublications();
    mocks.prepareAgentDefinition.mockImplementation(
      ({ config }: { config: unknown }) =>
        Effect.succeed({ config, setting: { defaultOutputFiles: [] } }),
    );
    // Production's `registerRun` commits the run's existence fact before it
    // returns, and a child's own rows (`child.turn`, its terminal fact) are
    // refused without it, so the spy publishes it and awaits durability too.
    mocks.registerRun.mockImplementation(
      (session: SessionHandle, runId: RunId) =>
        Effect.promise(async () => {
          publishTestRunStart(session, runId);
          await session.settlePublications();
        }),
    );
    mocks.releaseOwnedRunLease.mockResolvedValue(undefined);
    restoreAgentEngine = provideAgentEngine({
      executeAgent: (definition, runId, options) =>
        Effect.tryPromise({
          try: async () => {
            let reportedError: unknown;
            const turn = await mocks.executeAgent(definition, runId, {
              ...options,
              onRunError: (error: unknown, result: unknown) => {
                reportedError = error;
                return (
                  options as {
                    onRunError?: (e: unknown, r: unknown) => unknown;
                  }
                ).onRunError?.(error, result);
              },
            });
            recordTerminalFact(runId, turn, reportedError);
            return turn;
          },
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
        availability: 'provider-key',
      },
    ]);
    mocks.isProposalBypassed.mockReturnValue(true);
    mocks.isApprovalBypassedForRun.mockReturnValue(false);
    mocks.inspectRunLease.mockResolvedValue({ status: 'free' });
    const records = new Map<RunId, ReturnType<typeof memoryChildRecords>>();
    mocks.childRecords.mockImplementation((runId: RunId) => {
      let child = records.get(runId);
      if (!child) {
        child = memoryChildRecords();
        records.set(runId, child);
      }
      return child;
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
          Effect.provide(
            executeStableSubagentInBandEffect({
              runId: IN_BAND_LOGICAL_RUN_ID,
              parentRunId: prepared.parentRunId,
              session: prepared.session,
              signal,
              prepare: () => Effect.succeed(prepared),
            }),
            fakeProcessServices(),
          );
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
    stableSession.dispose();
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
      stableSession,
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
        output: result.result.output,
      }),
    );
    expect(mocks.writeResultMeta.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.releaseOwnedRunLease.mock.invocationCallOrder[0],
    );
  });

  it('commits stable success after artifact drain but before lease release', async () => {
    const logicalRunId = 'cccccc666666' as RunId;
    const order: string[] = [];
    const markers = watchAttemptMarkers(order);
    const settle = stableSession.flushArtifacts.bind(stableSession);
    const drain = vi
      .spyOn(stableSession, 'flushArtifacts')
      .mockImplementation(async () => {
        order.push('drain');
        await settle();
      });
    mocks.releaseOwnedRunLease.mockImplementationOnce(async () => {
      order.push('release');
    });

    try {
      await runInBand(delegationOptions(), logicalRunId);
    } finally {
      drain.mockRestore();
      markers.mockRestore();
    }

    expect(order).toContain('launched');
    expect(order.lastIndexOf('drain')).toBeLessThan(order.indexOf('committed'));
    expect(order.indexOf('committed')).toBeLessThan(order.indexOf('release'));
    expect(mocks.releaseOwnedRunLease).toHaveBeenCalledOnce();
  });

  it('releases the lease even when the post-drain stable commit fails', async () => {
    const logicalRunId = 'cccccc777777' as RunId;
    const phases: string[] = [];
    const markers = watchAttemptMarkers(
      phases,
      (phase) => phase === 'committed',
    );

    try {
      await expect(
        runInBand(delegationOptions(), logicalRunId),
      ).rejects.toMatchObject({
        name: 'SubagentCommitError',
        message: expect.stringContaining('Failed to commit durable completion'),
        cause: expect.objectContaining({ _tag: 'DatabaseWriteFailed' }),
      });
    } finally {
      markers.mockRestore();
    }

    expect(mocks.releaseOwnedRunLease).toHaveBeenCalledWith(logicalRunId);
    expect(phases).toContain('launched');
    expect(phases).not.toContain('retryable');
  });

  it('recovers committed success when lease deletion fails', async () => {
    const logicalRunId = 'cccccc999999' as RunId;
    const childRecords = memoryChildRecords();
    const releaseError = new Error('lease deletion failed');
    const phases: string[] = [];
    const markers = watchAttemptMarkers(phases);
    useChildRecords(childRecords);
    mocks.releaseOwnedRunLease.mockRejectedValueOnce(releaseError);

    try {
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
    } finally {
      markers.mockRestore();
    }

    expect(mocks.executeAgent).toHaveBeenCalledOnce();
    expect(phases).toContain('committed');
    expect(phases).not.toContain('retryable');
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
        output: expect.objectContaining({ response: 'Partial review.' }),
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
        output: expect.objectContaining({
          response: 'Waiting for clarification.',
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
    await seedStableMarkers(stableRunId, 1, [
      { attempt: 0, phase: 'committed' },
    ]);
    useChildRecords(completedChildRecords(persistedResult));
    const prepare = vi.fn(() =>
      Effect.fail(new Error('current agent is unavailable')),
    );

    await expect(
      executeStableSubagentInBand({
        runId: stableRunId,
        parentRunId: STABLE_PARENT_RUN_ID,
        session: stableSession,
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
    await seedStableMarkers(logicalRunId, 2, [
      { attempt: 1, phase: 'committed' },
    ]);
    const missingRecords = emptyChildRecords();
    const completedRecords = completedChildRecords(persistedResult);
    mocks.childRecords.mockImplementation((runId: RunId) =>
      runId === logicalRunId ? missingRecords : completedRecords,
    );
    const prepare = vi.fn();

    const recovered = await executeStableSubagentInBand({
      runId: logicalRunId,
      parentRunId: STABLE_PARENT_RUN_ID,
      session: stableSession,
      prepare,
    });

    expect(recovered.result).toEqual(persistedResult);
    expect(recovered.runId).not.toBe(logicalRunId);
    expect(prepare).not.toHaveBeenCalled();
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it('refuses to repeat a committed child whose result manifest is missing', async () => {
    const logicalRunId = 'cccccc888888' as RunId;
    await seedStableMarkers(logicalRunId, 1, [
      { attempt: 0, phase: 'committed' },
    ]);
    useChildRecords(emptyChildRecords());

    await expect(
      runInBand(delegationOptions(), logicalRunId),
    ).rejects.toBeInstanceOf(SubagentDurabilityError);
    expect(mocks.registerRun).not.toHaveBeenCalled();
    expect(mocks.executeAgent).not.toHaveBeenCalled();
  });

  it('refuses to repeat an incomplete stable child', async () => {
    const logicalRunId = 'dddddd444444' as RunId;
    await seedStableMarkers(logicalRunId, 1);
    useChildRecords(emptyChildRecords());

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
      await seedStableMarkers(logicalRunId, 1, [{ attempt: 0, phase }]);
      const records = new Map<RunId, ReturnType<typeof emptyChildRecords>>();
      mocks.childRecords.mockImplementation((id: RunId) => {
        let child = records.get(id);
        if (!child) {
          child = emptyChildRecords();
          records.set(id, child);
        }
        return child;
      });

      const completed = await runInBand(delegationOptions(), logicalRunId);

      expect(completed.runId).not.toBe(logicalRunId);
      expect(mocks.executeAgent).toHaveBeenCalledOnce();
    },
  );

  it('refuses to repeat a completed stable child when its manifest cannot be written', async () => {
    const logicalRunId = 'dddddd666666' as RunId;
    const phases: string[] = [];
    const markers = watchAttemptMarkers(phases);
    mocks.writeResultMeta.mockRejectedValueOnce(new Error('storage offline'));
    useChildRecords({
      ...emptyChildRecords(),
      writeResultMeta: mocks.writeResultMeta,
    });
    const options = delegationOptions();

    try {
      await expect(runInBand(options, logicalRunId)).rejects.toBeInstanceOf(
        SubagentDurabilityError,
      );

      expect(phases.at(-1)).toBe('launched');
      await expect(runInBand(options, logicalRunId)).rejects.toBeInstanceOf(
        SubagentDurabilityError,
      );
    } finally {
      markers.mockRestore();
    }
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
  });

  it('uses a new durable attempt after failed and cancelled children', async () => {
    const logicalRunId = 'eeeeee555555' as RunId;
    const priorOutcomes = ['failed', 'cancelled'] as const;
    await seedStableMarkers(logicalRunId, 0, [
      { attempt: 0, phase: 'committed' },
      { attempt: 1, phase: 'committed' },
    ]);
    const records = new Map<RunId, Record<string, unknown>>();
    mocks.childRecords.mockImplementation((id: RunId) => {
      let child = records.get(id);
      if (child) return child;
      const priorOutcome = priorOutcomes[records.size];
      child = priorOutcome
        ? completedChildRecords({
            outcome: priorOutcome,
            output: { category: 'toolUse', response: '', files: [] },
          })
        : emptyChildRecords();
      records.set(id, child);
      return child;
    });

    const completed = await runInBand(delegationOptions(), logicalRunId);

    expect(completed.runId).not.toBe(logicalRunId);
    expect(records.size).toBe(3);
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
    expect(mocks.registerRun).toHaveBeenCalledWith(
      stableSession,
      completed.runId,
      expect.anything(),
      'review',
      expect.objectContaining({ parentRunId: STABLE_PARENT_RUN_ID }),
    );
  });

  it('does not commit a cancelled stable child as successful', async () => {
    const logicalRunId = 'eeeeee666666' as RunId;
    const phases: string[] = [];
    const markers = watchAttemptMarkers(phases);
    useChildRecords(memoryChildRecords());
    mocks.executeAgent.mockResolvedValueOnce({
      outcome: 'cancelled',
      runId: logicalRunId,
      output: { category: 'toolUse', response: '', files: [] },
    });

    let completed;
    try {
      completed = await runInBand(delegationOptions(), logicalRunId);
    } finally {
      markers.mockRestore();
    }

    expect(completed.result.outcome).toBe('cancelled');
    expect(phases).not.toContain('committed');
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
    // The child's lease is still held, so the failure-time retryable marker
    // is refused: the attempt stays `launched`.
    const markers = watchAttemptMarkers([], (phase) => phase === 'retryable');
    useChildRecords(memoryChildRecords());
    const cleanup = vi
      .spyOn(stableSession, 'flushArtifacts')
      .mockRejectedValue(cleanupFailure);

    try {
      await expect(
        runInBand(delegationOptions(), logicalRunId),
      ).rejects.toMatchObject({
        name: 'SubagentDurabilityError',
        message: expect.stringContaining(
          'Failed to mark the stable attempt as retryable.',
        ),
        cause: expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({ cause: cleanupFailure }),
          ]),
        }),
      });
    } finally {
      cleanup.mockRestore();
      markers.mockRestore();
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
    let abandonedLeasePresent = true;
    const markers = watchAttemptMarkers(
      [],
      (phase) => abandonedLeasePresent && phase === 'retryable',
    );
    useChildRecords(memoryChildRecords());
    const cleanup = vi
      .spyOn(stableSession, 'flushArtifacts')
      .mockRejectedValue(cleanupFailure);

    try {
      await expect(
        runInBand(delegationOptions(), logicalRunId),
      ).rejects.toMatchObject({
        name: 'SubagentDurabilityError',
        message: expect.stringContaining(
          'Failed to mark the stable attempt as retryable.',
        ),
        cause: expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({ cause: cleanupFailure }),
          ]),
        }),
      });
    } finally {
      cleanup.mockRestore();
    }

    // Perform the restart repair's observable lease transition before the
    // stable call resumes: the abandoned lease no longer fences the marker
    // write. That absence must not attest artifact-release success; only the
    // explicit post-drain commit marker can do that.
    abandonedLeasePresent = false;
    await expect(
      runInBand(delegationOptions(), logicalRunId),
    ).rejects.toBeInstanceOf(SubagentDurabilityError);
    markers.mockRestore();
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
  });

  it('preserves the child failure when its failure manifest cannot be written', async () => {
    mocks.executeAgent.mockRejectedValueOnce(new Error('review model failed'));
    mocks.writeResultMeta.mockRejectedValueOnce(new Error('storage offline'));

    await expectDurabilityErrorPreservingChildFailure(
      runInBand(delegationOptions()),
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
        output: expect.objectContaining({ response: '' }),
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
        output: expect.objectContaining({ response: 'The proof is correct.' }),
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
      expect.objectContaining({ producer: 'subagent', agentName: 'review' }),
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
      action: 'cancel',
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
    const decider = answerOpenedRequests(session, { action: 'approve' });
    try {
      const result = await withRunContext(
        parentRunContext({ session, approvalPromptsUnavailable: true }),
        () => callDelegateReview(),
      );

      await waitForChildren(session);
      expect(decider.openedKinds).toEqual([]);
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
      await decider.stop();
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
        availability: 'provider-key',
      },
      { value: 'gpt5', label: 'GPT-5', availability: 'provider-key' },
    ]);

    const result = await delegateWithProposalDecision(
      { action: 'approve', model: 'gpt5' },
      { expectLaunch: true },
    );

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
