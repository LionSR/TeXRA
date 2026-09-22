// Test composition imports

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Stream } from 'effect';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  vi,
  type MockInstance,
} from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { ToolCallShape } from '@agent/runtime/ToolCall';
import type { RunHandle } from '@agent/runtime/RunHandle';
import { Runs } from '@agent/runtime/runRegistry';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  RUN_PHASE,
  AgentCategory,
  agentMatchesIdentifier,
} from '@shared/schemas';
import type { ModelOptionData, RequestDecision, RunId } from '@shared/schemas';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  createTestSession,
  publishTestRunStart,
  queuedFollowUps,
} from '@test/support/sessionTestUtils';
import { fakeProcessServices } from '@test/support/setupPlatform';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { DelegateAgentTool } from '@tools/delegation/DelegationTools';
import {
  executeSubagentInBand as executeSubagentInBandEffect,
  SubagentDurabilityError,
} from '@tools/delegation/inBandSubagentRun';
import { provideAgentEngine } from '@tools/delegation/nativeSubagentStrategy';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

const mocks = vi.hoisted(() => ({
  configureDelegatedChildApprovals: vi.fn(),
  executeAgent: vi.fn(),
  prepareAgentDefinition: vi.fn(),
  resumeToolUseTurn: vi.fn(),
  childRecords: vi.fn(),
  getVisibleAgents: vi.fn(),
  isApprovalBypassedForRun: vi.fn(),
  isProposalBypassed: vi.fn(),
  registerRun: vi.fn(),
  writeReport: vi.fn(),
  writeResultMeta: vi.fn(),
  readModelAvailabilityInputs: vi.fn(),
}));

vi.mock('@agent/runtime/AgentLaunchContext', () => ({
  prepareAgentDefinition: mocks.prepareAgentDefinition,
}));

// Delegation resolves targets through the scope resolver; with no active run
// scope that is the workspace-visible roster, and identity matching is
// agentRegistry's own rule — mirrored here rather than re-implemented.
vi.mock('@agent/index/agentRegistry', () => ({
  getVisibleAgents: mocks.getVisibleAgents,
  resolveDelegationScopeAgents: (
    _stores: unknown,
    scope: unknown,
    category: AgentCategory,
  ) => (scope ? [] : mocks.getVisibleAgents(category)),
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
  readModelAvailabilityInputs: mocks.readModelAvailabilityInputs,
  // Availability is read once and finished purely, so a case seeds the option
  // rows on the read and the pure finisher hands them straight back.
  modelOptionsFrom: (rows: readonly ModelOptionData[]) => rows,
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
    userInstruction: string;
    hooks: NonNullable<ToolCallShape['hooks']>;
  }> = {},
): Parameters<typeof nativeToolTestLayer>[0] {
  const session = overrides.session ?? testDefaultSession();
  const stopAfterCycle = overrides.stopAfterCycle ?? false;
  return {
    ...(overrides.userInstruction !== undefined && {
      userInstruction: overrides.userInstruction,
    }),
    ...(overrides.hooks !== undefined && { hooks: overrides.hooks }),
    run: {
      runId: overrides.runId ?? PARENT_RUN_ID,
      session,
      config: AgentConfigSchema.parse({ agent: 'chat', model: 'deepseekT' }),
      toolPolicy: {
        stopAfterCycle,
        approvalPromptsUnavailable:
          overrides.approvalPromptsUnavailable ?? false,
        runtimeUnavailableTools: [],
      },
    },
  };
}

/** The shared delegation call used by nearly every case. */
function callDelegateReview(call = parentRunContext()) {
  return new DelegateAgentTool()
    .call({
      agent: 'review',
      model: null,
      instruction: 'Check the proof.',
      memories: [],
      working_directory: null,
      execution_id: null,
    })
    .pipe(Effect.provide(nativeToolTestLayer(call)));
}

const waitForChildrenEffect = Effect.fn('waitForTestChildren')(function* (
  session: SessionHandle,
) {
  while (true) {
    const active = session.runs.getActiveIds();
    if (active.length === 0) return;
    yield* session.runs.waitForAnyChange(active);
  }
});

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
    stop: () => Fiber.interrupt(fiber),
  };
}

/** The same delegation routed through the request protocol, with `decision`
 *  answering the proposal the run opens. The session owns the decider, so it
 *  is created and disposed per case. */
function delegateWithProposalDecision(
  decision: RequestDecision,
  options: { launchSignal?: Deferred.Deferred<void> } = {},
) {
  return Effect.scoped(
    Effect.gen(function* () {
      mocks.isProposalBypassed.mockReturnValue(false);
      const session = createTestSession();
      const decider = answerOpenedRequests(session, decision);
      yield* Effect.addFinalizer(() =>
        decider.stop().pipe(Effect.ensuring(session.dispose())),
      );
      // A request is a row on its run, so the parent run must exist first.
      publishTestRunStart(session, PARENT_RUN_ID);
      yield* session.settlePublications();
      const result = yield* callDelegateReview(parentRunContext({ session }));
      // A detached child commits its `child.turn` row before its first turn
      // runs, so the launch is not observable the moment the tool returns and
      // the session must not be disposed out from under it.
      if (options.launchSignal) {
        yield* Deferred.await(options.launchSignal);
      }
      yield* waitForChildrenEffect(session);
      return result;
    }),
  );
}

const IN_BAND_PARENT_RUN_ID = 'abcdef123456' as RunId;
const IN_BAND_RUN_ID = 'aaaaaa111111' as RunId;

/**
 * The in-band caller's session, one per case: a child's rows live on its own
 * aggregate, so a shared database would let one case read the runs another
 * case left behind.
 */
let inBandSession: SessionHandle;

type PreparedInBandSubagentOptions = Effect.Success<
  ReturnType<Parameters<typeof executeSubagentInBandEffect>[0]['prepare']>
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
    parentRunId: IN_BAND_PARENT_RUN_ID,
    session: inBandSession,
    ...overrides,
  };
}

/** Run the typed required-result path the way production callers reach it. */
function runInBand(
  options: InBandSubagentRunOptions,
  runId: RunId = IN_BAND_RUN_ID,
) {
  const { signal, ...prepared } = options;
  return executeSubagentInBandEffect({
    runId,
    parentRunId: prepared.parentRunId,
    session: prepared.session,
    signal,
    prepare: () => Effect.succeed(prepared),
  }).pipe(
    Effect.provide(fakeProcessServices()),
    Effect.provideService(Runs, prepared.session.runs),
  );
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

/**
 * One-shot executeAgent mock that tracks a live child handle and returns the
 * WAITING result the child-run loop delivers from.
 */
function mockWaitingChildOnce(
  options: {
    memoryMisses?: ReadonlyArray<{ path: string; reason: string }>;
    afterRun?: (handle: RunHandle) => Promise<void>;
  } = {},
): void {
  mocks.executeAgent.mockImplementationOnce(
    async (_config, runId: RunId, runOptions) => {
      const handle = testRunHandle({
        runId,
        parent: PARENT_RUN_ID,
        agent: 'review',
      });
      testDefaultSession().runs.track(handle);
      runOptions.onRunResolved?.(runId);
      Effect.runSync(runOptions.onRun?.(handle) ?? Effect.void);
      await options.afterRun?.(handle);
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

/** In-memory child records: the surface a required-result caller reads. */
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
 * violation that the same lifecycle ends as FAILED, and a drain that rolled
 * this run's queued facts back is the row's outcome and its `artifact-drain`
 * kind, whatever the flow reported.
 */
function recordTerminalFact(
  runId: RunId,
  turn: unknown,
  reportedError: unknown,
  drainFailure: Error | undefined,
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
  const reported = flow.outcome === RUN_PHASE.WAITING ? 'failed' : flow.outcome;
  const outcome = drainFailure === undefined ? reported : 'failed';
  const flowError =
    outcome === 'failed' && reportedError !== undefined
      ? { kind: 'unexpected', message: toErrorMessage(reportedError) }
      : undefined;
  const error =
    drainFailure === undefined
      ? flowError
      : { kind: 'artifact-drain', message: toErrorMessage(drainFailure) };
  store.recordRunEnd({
    outcome,
    ...(error ? { error } : {}),
    ...(flow.usage ? { usage: flow.usage } : {}),
    output: flow.output,
  });
}

describe('headless delegation', () => {
  let restoreAgentEngine = (): void => {};
  /**
   * The claim release the session's exit choreography ends with. The failure
   * paths fail it rather than `releaseRunLease` itself, so the drain, the
   * terminal write and the settle above it still run for real.
   */
  let releaseClaims: MockInstance<SessionHandle['releaseClaims']>;

  beforeEach(async () => {
    vi.clearAllMocks();
    releaseClaims = vi.spyOn(SessionHandle.prototype, 'releaseClaims');
    // A child registers under its parent, and a run's aggregate must begin
    // with its own `run.start`.
    inBandSession = createTestSession();
    publishTestRunStart(inBandSession, IN_BAND_PARENT_RUN_ID);
    await Effect.runPromise(inBandSession.settlePublications());
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
          await Effect.runPromise(session.settlePublications());
        }),
    );
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
            // Production's lifecycle drains the facts this run queued before
            // it writes the terminal row, and the row is the post-drain fact
            // (`finalizeRunTerminal`); the drain runs here too, so a
            // publication that fails only once is marked on the row and gone
            // by the time the lease-release drain runs.
            const drainFailure = await Effect.runPromise(
              options.session.settlePublications(runId).pipe(
                Effect.as(undefined),
                Effect.catch((cause) => Effect.succeed(cause)),
              ),
            );
            recordTerminalFact(runId, turn, reportedError, drainFailure);
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
    mocks.getVisibleAgents.mockReturnValue(
      Effect.succeed([
        {
          name: 'review',
          source: 'builtInToolUse',
          description: 'Review work.',
          tools: [],
        },
      ]),
    );
    mocks.readModelAvailabilityInputs.mockReturnValue(
      Effect.succeed([
        {
          value: 'deepseekT',
          label: 'DeepSeek',
          availability: 'provider-key',
        },
      ]),
    );
    mocks.isProposalBypassed.mockReturnValue(true);
    mocks.isApprovalBypassedForRun.mockReturnValue(false);
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

  it.effect(
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
            executeSubagentInBandEffect({
              runId: IN_BAND_RUN_ID,
              parentRunId: prepared.parentRunId,
              session: prepared.session,
              signal,
              prepare: () => Effect.succeed(prepared),
            }).pipe(Effect.provideService(Runs, prepared.session.runs)),
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
    const session = testDefaultSession();
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
    await Effect.runPromise(inBandSession.dispose());
  });

  it.effect('awaits child delegation during one-shot tool-use runs', () =>
    Effect.gen(function* () {
      const result = yield* callDelegateReview(
        parentRunContext({ stopAfterCycle: true }),
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
    }),
  );

  it.effect(
    'composes durable workflow calls through the native launch primitive',
    () =>
      Effect.gen(function* () {
        const result = yield* runInBand(delegationOptions());

        expect(mocks.executeAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.objectContaining({ agent: 'review' }),
          }),
          result.runId,
          expect.objectContaining({ stopAfterCycle: true }),
        );
        expect(result.result).toEqual({
          outcome: 'completed',
          output: {
            category: 'toolUse',
            response: 'The proof is correct.',
            files: [],
          },
        });
        expect(mocks.writeReport).toHaveBeenCalled();
        expect(mocks.registerRun).toHaveBeenCalledWith(
          inBandSession,
          result.runId,
          expect.objectContaining({ agent: 'review' }),
          'review',
          expect.objectContaining({ parentRunId: IN_BAND_PARENT_RUN_ID }),
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
          releaseClaims.mock.invocationCallOrder[0] ?? 0,
        );
      }),
  );

  it.effect(
    'returns the committed result when the final claim release fails',
    () =>
      Effect.gen(function* () {
        const drain = vi.spyOn(inBandSession, 'settlePublications');
        releaseClaims.mockReturnValueOnce(
          Effect.fail(new Error('claim release failed')),
        );

        const result = yield* runInBand(delegationOptions());

        expect(result.result.outcome).toBe('completed');
        expect(mocks.writeResultMeta).toHaveBeenCalledOnce();
        // The release that failed is the last step: everything the exit
        // choreography owes the run happened before it.
        expect(drain).toHaveBeenCalled();
        // The failure injected is the run's own release, not a neighbour's.
        expect(releaseClaims).toHaveBeenCalledOnce();
      }),
  );

  it.effect(
    'does not return a typed result when the final artifact drain fails',
    () =>
      Effect.gen(function* () {
        const drainFailure = new Error('artifact flush failed');
        const settle = inBandSession.settlePublications.bind(inBandSession);
        // Every drain of the child's own facts fails; a session-wide settle
        // (the registration barrier) still runs.
        const drain = vi
          .spyOn(inBandSession, 'settlePublications')
          .mockImplementation((runId, options) =>
            runId === IN_BAND_RUN_ID
              ? Effect.fail(drainFailure)
              : settle(runId, options),
          );

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => drain.mockRestore()),
        );

        expect(
          yield* Effect.flip(runInBand(delegationOptions())),
        ).toMatchObject({
          name: 'SubagentDurabilityError',
          message: expect.stringContaining(
            'failed to commit its final artifacts',
          ),
          cause: expect.objectContaining({ name: 'RunArtifactDrainError' }),
        });
      }),
  );

  it.effect(
    'does not return a typed result when only the pre-terminal drain fails',
    () =>
      Effect.gen(function* () {
        const settle = inBandSession.settlePublications.bind(inBandSession);
        let childDrains = 0;
        // Only the child's first drain (the pre-terminal one) fails.
        const drain = vi
          .spyOn(inBandSession, 'settlePublications')
          .mockImplementation((runId, options) =>
            runId === IN_BAND_RUN_ID && childDrains++ === 0
              ? Effect.fail(new Error('queued publication failed'))
              : settle(runId, options),
          );

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => drain.mockRestore()),
        );

        expect(
          yield* Effect.flip(runInBand(delegationOptions())),
        ).toMatchObject({
          name: 'SubagentDurabilityError',
          message: expect.stringContaining(
            'failed to commit its final artifacts',
          ),
        });
        expect(childDrains).toBe(3);
      }),
  );

  it.effect('records a failed child cost once for durable in-band run', () =>
    Effect.gen(function* () {
      const onCost = vi.fn();
      mockExecuteAgentErrorOnce(0.61, {
        runId: IN_BAND_RUN_ID,
        output: {
          category: 'toolUse',
          response: 'Partial review.',
          files: [],
        },
      });

      const error = yield* Effect.flip(
        runInBand(delegationOptions({ onCost })),
      );
      expect(error.message).toContain('review model failed');
      expect(onCost).toHaveBeenCalledOnce();
      expect(onCost).toHaveBeenCalledWith(0.61);
      expect(mocks.writeResultMeta).toHaveBeenCalledOnce();
      expect(mocks.writeResultMeta).toHaveBeenCalledWith(
        expect.objectContaining({
          output: expect.objectContaining({ response: 'Partial review.' }),
        }),
      );
    }),
  );

  it.effect(
    'persists a cost-bearing WAITING result as a durable single-cycle failure',
    () =>
      Effect.gen(function* () {
        const onCost = vi.fn();
        mocks.executeAgent.mockResolvedValueOnce({
          outcome: RUN_PHASE.WAITING,
          runId: IN_BAND_RUN_ID,
          output: {
            category: 'toolUse',
            response: 'Waiting for clarification.',
            files: [],
          },
          usage: { totalCost: 0.73 },
        });

        const error = yield* Effect.flip(
          runInBand(delegationOptions({ onCost })),
        );
        expect(error.message).toContain(
          `Single-cycle subagent ${IN_BAND_RUN_ID} unexpectedly suspended.`,
        );
        expect(mocks.executeAgent).toHaveBeenCalledWith(
          expect.any(Object),
          IN_BAND_RUN_ID,
          expect.objectContaining({
            parentRunId: IN_BAND_PARENT_RUN_ID,
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
      }),
  );

  it.effect(
    'does not return a typed result when its durable manifest cannot be written',
    () =>
      Effect.gen(function* () {
        mocks.writeResultMeta.mockRejectedValueOnce(
          new Error('storage offline'),
        );
        expect(
          yield* Effect.flip(runInBand(delegationOptions())),
        ).toBeInstanceOf(SubagentDurabilityError);
        expect(mocks.writeReport).toHaveBeenCalled();
      }),
  );

  it.effect(
    'preserves the child failure when final claim cleanup also fails',
    () =>
      Effect.gen(function* () {
        const childFailure = new Error('review model failed');
        mocks.executeAgent.mockRejectedValueOnce(childFailure);
        releaseClaims.mockReturnValueOnce(
          Effect.fail(new Error('claim release failed')),
        );
        expect(yield* Effect.flip(runInBand(delegationOptions()))).toBe(
          childFailure,
        );
        // The failure manifest is written above the release that failed.
        expect(mocks.writeResultMeta).toHaveBeenCalledOnce();
      }),
  );

  it.effect(
    'preserves the child failure when its failure manifest cannot be written',
    () =>
      Effect.gen(function* () {
        mocks.executeAgent.mockRejectedValueOnce(
          new Error('review model failed'),
        );
        mocks.writeResultMeta.mockRejectedValueOnce(
          new Error('storage offline'),
        );
        expect(
          yield* Effect.flip(runInBand(delegationOptions())),
        ).toMatchObject({
          name: 'SubagentDurabilityError',
          message: expect.stringContaining('review model failed'),
          cause: expect.objectContaining({ name: 'AggregateError' }),
        });
      }),
  );

  it.effect('interrupts the live child when the in-band caller aborts', () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const onCost = vi.fn();
      const ready = yield* Deferred.make<void>();
      let childInterrupted!: () => void;
      const interrupted = new Promise<void>((resolve) => {
        childInterrupted = resolve;
      });
      const interrupt = vi.fn(() => {
        childInterrupted();
        return true;
      });
      mocks.executeAgent.mockImplementationOnce(
        async (_config, _id, options) => {
          await Effect.runPromise(
            options.onRun?.({ interrupt } as never) ?? Effect.void,
          );
          Deferred.doneUnsafe(ready, Effect.void);
          await interrupted;
          return {
            outcome: 'cancelled',
            runId: CHILD_RUN_ID,
            output: { category: 'toolUse', response: '', files: [] },
          };
        },
      );

      const running = yield* Effect.forkChild(
        Effect.flip(
          runInBand(delegationOptions({ signal: controller.signal, onCost })),
        ),
      );
      yield* Deferred.await(ready);
      controller.abort(new Error('Workflow stopped.'));

      const error = yield* Fiber.join(running);
      expect(error.message).toContain('Workflow stopped.');
      expect(interrupt).toHaveBeenCalledOnce();
      expect(onCost).toHaveBeenCalledOnce();
      expect(mocks.writeResultMeta).toHaveBeenCalledOnce();
      expect(mocks.writeResultMeta).toHaveBeenLastCalledWith(
        expect.objectContaining({
          producer: 'subagent',
          output: expect.objectContaining({ response: '' }),
        }),
      );
    }),
  );

  it.effect(
    'keeps the completed child result when cancellation arrives during persistence',
    () =>
      Effect.gen(function* () {
        const controller = new AbortController();
        const persisting = yield* Deferred.make<void>();
        let finishPersistence!: () => void;
        const persistencePending = new Promise<void>((resolve) => {
          finishPersistence = resolve;
        });
        mocks.writeResultMeta.mockImplementationOnce(() => {
          Deferred.doneUnsafe(persisting, Effect.void);
          return persistencePending;
        });

        const running = yield* Effect.forkChild(
          Effect.flip(
            runInBand(delegationOptions({ signal: controller.signal })),
          ),
        );
        yield* Deferred.await(persisting);
        controller.abort(new Error('Workflow stopped after child completion.'));
        finishPersistence();

        const error = yield* Fiber.join(running);
        expect(error.message).toContain(
          'Workflow stopped after child completion.',
        );
        expect(mocks.writeResultMeta).toHaveBeenCalledOnce();
        expect(mocks.writeResultMeta).toHaveBeenCalledWith(
          expect.objectContaining({
            producer: 'subagent',
            output: expect.objectContaining({
              response: 'The proof is correct.',
            }),
          }),
        );
      }),
  );

  it.effect(
    'does not register a child when the in-band caller is already aborted',
    () =>
      Effect.gen(function* () {
        const controller = new AbortController();
        controller.abort(new Error('Workflow already stopped.'));

        const error = yield* Effect.flip(
          runInBand(delegationOptions({ signal: controller.signal })),
        );
        expect(error.message).toContain('Workflow already stopped.');
        expect(mocks.registerRun).not.toHaveBeenCalled();
        expect(mocks.executeAgent).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'carries the validated agent source to executeAgent for source-pinned launch',
    () =>
      Effect.gen(function* () {
        // The delegation validates against the visible roster and must hand the
        // resolved entry's source to executeAgent, so getAgentPath resolves the exact
        // (source, name) key instead of re-resolving the ambiguous bare name.
        yield* callDelegateReview(parentRunContext({ stopAfterCycle: true }));

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
      }),
  );

  it.effect('extends the bare instruction with injected handoff guidance', () =>
    Effect.gen(function* () {
      // Regression pin for #5864: delegation must inject handoff guidance rather
      // than hand the caller's instruction through verbatim. Deliberately
      // wording-free — the injected copy churns (#9568) without behavior changing.
      yield* callDelegateReview();
      yield* waitForChildrenEffect(testDefaultSession());

      const instruction =
        mocks.executeAgent.mock.calls.at(-1)?.[0].config.instruction;
      expect(instruction).toContain('Check the proof.');
      expect(instruction.length).toBeGreaterThan('Check the proof.'.length);
    }),
  );

  it.effect(
    'carries the current parent instruction into the subagent constraint context',
    () =>
      Effect.gen(function* () {
        const parentInstruction =
          'Do not use plans, todos, files, bash, Wolfram, or other child tools. Delegate exactly once.';
        yield* callDelegateReview(
          parentRunContext({ userInstruction: parentInstruction }),
        );
        yield* waitForChildrenEffect(testDefaultSession());

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
      }),
  );

  it.effect('formats returned child error results as subagent errors', () =>
    Effect.gen(function* () {
      const recordSubagentCost = vi.fn();
      mockExecuteAgentErrorOnce(0.42);

      const result = yield* callDelegateReview(
        parentRunContext({
          stopAfterCycle: true,
          hooks: { recordSubagentCost },
        }),
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
          producer: 'subagent',
          agentName: 'review',
        }),
      );
    }),
  );

  it.effect('rolls up failed async subagent cost from the error callback', () =>
    Effect.gen(function* () {
      const costRecorded = Deferred.makeUnsafe<void>();
      const recordSubagentCost = vi.fn(() => {
        Deferred.doneUnsafe(costRecorded, Effect.void);
      });
      mockExecuteAgentErrorOnce(0.31);

      const result = yield* callDelegateReview(
        parentRunContext({ hooks: { recordSubagentCost } }),
      );

      expect(result.summary).toBe("Launched 'review' (async)");
      yield* Deferred.await(costRecorded);
      expect(recordSubagentCost).toHaveBeenCalledTimes(1);
      expect(recordSubagentCost).toHaveBeenCalledWith(0.31);
    }),
  );

  it.effect(
    'composes interactive delegation through the same native launch primitive',
    () =>
      Effect.gen(function* () {
        const result = yield* callDelegateReview();

        expect(result.summary).toBe("Launched 'review' (async)");
        expect(result.output).toContain(
          "Subagent 'review' launched. Result will be delivered automatically",
        );
        yield* waitForChildrenEffect(testDefaultSession());
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
      }),
  );

  it.effect('does not attribute proposal cancellation to the user', () =>
    Effect.gen(function* () {
      const result = yield* delegateWithProposalDecision({
        action: 'cancel',
        cause: 'CLI approval prompt failed.',
      });

      expect(result.summary).toBe("Delegation approval cancelled for 'review'");
      expect(result.error).toContain('CLI approval prompt failed.');
      expect(result.error).not.toContain('User feedback:');
      expect(mocks.executeAgent).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'proceeds without a proposal when the run cannot present approval prompts',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // Headless `--approval-policy never` withholds `requiresApproval` tools up
          // front, so a delegation tool that still executes was deliberately offered
          // (delegate_multi_agents). The proposal gate must not settle a
          // guaranteed denial; the child stays on inherited approval state.
          mocks.isProposalBypassed.mockReturnValue(false);
          const session = createTestSession();
          const decider = answerOpenedRequests(session, { action: 'approve' });
          yield* Effect.addFinalizer(() =>
            decider.stop().pipe(Effect.ensuring(session.dispose())),
          );
          const result = yield* callDelegateReview(
            parentRunContext({ session, approvalPromptsUnavailable: true }),
          );

          yield* waitForChildrenEffect(session);
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
        }),
      ),
  );

  it.effect(
    'rejects an approved model override unavailable in the active API mode',
    () =>
      Effect.gen(function* () {
        // Only deepseekT is available (see beforeEach); gpt5 is not, so the
        // override must be rejected synchronously, mirroring the initial delegate
        // path's availability gate.
        const result = yield* delegateWithProposalDecision({
          action: 'approve',
          model: 'gpt5',
        });

        expect(result.status).toBe('error');
        expect(result.summary).toBe(
          "Approved model override 'gpt5' is not available",
        );
        expect(mocks.executeAgent).not.toHaveBeenCalled();
      }),
  );

  it.effect('launches with an approved model override that is available', () =>
    Effect.gen(function* () {
      mocks.readModelAvailabilityInputs.mockReturnValue(
        Effect.succeed([
          {
            value: 'deepseekT',
            label: 'DeepSeek',
            availability: 'provider-key',
          },
          {
            value: 'gpt5',
            label: 'GPT-5',
            availability: 'provider-key',
          },
        ]),
      );

      const launched = Deferred.makeUnsafe<void>();
      mocks.executeAgent.mockImplementationOnce(async () => {
        Deferred.doneUnsafe(launched, Effect.void);
        return {
          outcome: 'completed',
          runId: CHILD_RUN_ID,
          output: {
            category: 'toolUse',
            response: 'The proof is correct.',
            files: [],
          },
        };
      });

      const result = yield* delegateWithProposalDecision(
        { action: 'approve', model: 'gpt5' },
        { launchSignal: launched },
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
    }),
  );

  it.effect(
    'includes memory misses in interactive early-delivered reports',
    () =>
      Effect.gen(function* () {
        // The mocked `executeAgent` is the child-run loop's `launch` turn, and the
        // WAITING result it returns is what the loop's single delivery site sees.
        mockWaitingChildOnce({
          memoryMisses: [
            { path: '/memories/missing.md', reason: 'not found & unreadable' },
          ],
        });

        const reportWritten = Deferred.makeUnsafe<void>();
        mocks.writeReport.mockImplementationOnce(() => {
          Deferred.doneUnsafe(reportWritten, Effect.void);
        });

        yield* callDelegateReview(parentRunContext({ runId: PARENT_RUN_ID }));

        yield* Deferred.await(reportWritten);
        expect(mocks.writeReport).toHaveBeenCalledWith(
          expect.stringContaining(
            '<memory-miss path="/memories/missing.md" reason="not found &amp; unreadable" />',
          ),
        );
      }),
  );

  it.effect(
    'does not deliver detached subagent results back to the released parent',
    () =>
      Effect.gen(function* () {
        let capturedHandle: RunHandle | undefined;

        mockWaitingChildOnce({
          // Detach happens between the loop capturing the handle (onRun) and the
          // loop delivering this turn's result (after the mock resolves) — the
          // same ordering a real stop-with-detach produces mid-turn.
          afterRun: (handle) => {
            capturedHandle = handle;
            return Effect.runPromise(
              testDefaultSession().runs.detachActiveChildren(PARENT_RUN_ID),
            );
          },
        });

        const reportWritten = Deferred.makeUnsafe<void>();
        mocks.writeReport.mockImplementationOnce(() => {
          Deferred.doneUnsafe(reportWritten, Effect.void);
        });

        yield* callDelegateReview(parentRunContext({ runId: PARENT_RUN_ID }));

        yield* Deferred.await(reportWritten);
        expect(mocks.writeReport).toHaveBeenCalledWith(
          expect.stringContaining('The proof is correct.'),
        );
        expect(capturedHandle?.deliveryTarget).toBeUndefined();
        expect(
          yield* queuedFollowUps(testDefaultSession(), PARENT_RUN_ID),
        ).toEqual([]);
        expect(
          yield* queuedFollowUps(testDefaultSession(), CHILD_RUN_ID),
        ).toEqual([]);
      }),
  );
});
