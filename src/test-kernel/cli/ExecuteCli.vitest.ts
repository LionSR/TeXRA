import '@test/support/sessionGraphTestSetup';
import { it } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { Deferred, Effect, Fiber } from 'effect';

import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { RunAgentOptions } from '@agent/runtime/runAgent';
import { RunHandle } from '@agent/runtime/RunHandle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { executeCliRequest } from '@cli/runtime/executeCli';
import { AgentError } from '@common/errors';
import { RUN_OUTCOME } from '@shared/schemas';
import type { AggregateId, FlowSnapshotPayload, RunId } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { untrackRun } from '@test/support/sessionEnd';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  fakeProcessServices,
  installFakeHost,
  installedHost,
} from '@test/support/setupPlatform';
import { createTestCliContext as cliContext } from '@test/cli/fixtures/cliContext';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { admitInterruptibleRun } from '@test/support/runHandleFixtures';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  emit: vi.fn(),
  attachRunProgressRenderer: vi.fn(),
  detachRunProgressRenderer: vi.fn(),
  detachSessionProgressProjection: vi.fn(),
  detachWorkflowPlainOutput: vi.fn(),
  attachWorkflowPlainOutput: vi.fn(),
  createHeadlessCliHostInteractions: vi.fn(),
  createCliRuntimeHost: vi.fn(),
  disposeHostInteractions: vi.fn(),
  prepareInteractivePrompt: vi.fn(),
  readCliRunOutcomeState: vi.fn(),
  deriveResumability: vi.fn(),
  releaseRunLeaseAfterArtifacts: vi.fn(),
  runAgent: vi.fn(),
  writeTextStderr: vi.fn(),
  writeTextStderrAndWait: vi.fn<() => Promise<void>>(async () => undefined),
  finalizeRun: vi.fn(),
}));

/** Lets the forked run fiber and the process-runtime shutdown handler cross a macrotask. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

const tempDirs = useTempDirs();

async function installFreshDefaultSession(): Promise<void> {
  await installStoragePlatform();
  await import('@test/support/sessionGraphTestSetup');
  const { initializeDefaultSession, teardownDefaultSession } =
    await import('@agent/runtime/sessionGraph');
  await Effect.runPromise(teardownDefaultSession());
  await Effect.runPromise(
    initializeDefaultSession({ roots: testWorkspaceRoots() }),
  );
}

async function installStoragePlatform(): Promise<void> {
  await installFakeHost(await createTempDirPlatform('texra-run-', tempDirs));
}

/**
 * The agent boundary `executeCliRequest` runs through, injected through its
 * own options seam: the launch, the terminal-status drain, and the
 * resumability read all land in the suite's mock bag.
 */
const agentRunsFake = {
  launch: (...args: unknown[]) => Effect.promise(() => mocks.runAgent(...args)),
  finalize: (_session: unknown, input: unknown) =>
    Effect.promise(() => mocks.finalizeRun(input)),
  resumability: (...args: unknown[]) =>
    Effect.promise(() => mocks.deriveResumability(...args)),
} as NonNullable<Parameters<typeof executeCliRequest>[2]['agentRuns']>;

vi.mock('@cli/runtime/cliPresentationHost', () => ({
  createCliRuntimeHost: mocks.createCliRuntimeHost,
}));

vi.mock('@cli/runtime/approvalAdapter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/approvalAdapter')>()),
  createHeadlessCliHostInteractions: mocks.createHeadlessCliHostInteractions,
}));

vi.mock('@cli/runtime/terminalStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/terminalStatus')>()),
  readCliRunOutcomeState: (...args: unknown[]) =>
    Effect.tryPromise(() => mocks.readCliRunOutcomeState(...args)),
}));

vi.mock('@cli/runtime/sessionProgressSubscription', () => ({
  attachCliSessionProgressProjection: vi.fn(() =>
    Effect.succeed(Effect.suspend(mocks.detachSessionProgressProjection)),
  ),
}));

vi.mock('@cli/runtime/workflowPlainOutput', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@cli/runtime/workflowPlainOutput')
  >()),
  attachWorkflowPlainOutput: mocks.attachWorkflowPlainOutput,
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStderr: mocks.writeTextStderr,
  writeTextStderrAndWait: mocks.writeTextStderrAndWait,
}));

type CliRequest = Parameters<typeof executeCliRequest>[0];

/** Result shape the default `runAgent` stub resolves with. */
const COMPLETED_RUN = {
  outcome: 'completed',
  output: { category: 'toolUse', response: '', files: [] },
  runId: 'exec-1',
} as const;

const COMPLETED_WORKFLOW_RUN: Parameters<
  NonNullable<RunAgentOptions['openWorkflowOutput']>
>[0] = {
  outcome: 'completed',
  output: {
    category: 'workflow',
    outputs: [],
    compileFailures: [],
    diffs: [],
  },
  runId: 'exec-1' as RunId,
};

function baseRequest(kind: 'fresh' | 'resume' = 'fresh'): CliRequest {
  const request = { config: {}, runId: 'exec-1' } as const;
  return kind === 'fresh'
    ? ({ kind, ...request } as CliRequest)
    : ({ kind, ...request } as CliRequest);
}

function toolUseConfig() {
  return {
    agent: 'chat',
    model: 'gpt54',
    inputFiles: [] as string[],
    contextFiles: [] as string[],
    instruction: 'Check this.',
    workingDirectory: '/tmp/project',
    agentCategory: 'toolUse' as const,
  };
}

/** A run program's options with the session, runtime and lifecycle the
 *  wrapper below supplies. */
type WithoutSession<O> = Omit<O, 'session' | 'runtime' | 'lifecycle'>;

async function loadExecuteCli() {
  const runtime = await import('@cli/runtime/executeCli');
  // The commands thread `initCliPlatform`'s session, runtime and lifecycle
  // in; here the process default this file installs stands in for the first
  // two and the installed host's lifecycle for the third.
  return {
    ...runtime,
    executeCliRequest: (
      request: Parameters<typeof runtime.executeCliRequest>[0],
      context: Parameters<typeof runtime.executeCliRequest>[1],
      options: WithoutSession<
        Parameters<typeof runtime.executeCliRequest>[2]
      > = {},
    ) =>
      Effect.provide(
        runtime.executeCliRequest(request, context, {
          session: Effect.succeed(testDefaultSession()),
          runtime: testRuntime(),
          lifecycle: installedHost().platform.lifecycle,
          agentRuns: agentRunsFake,
          ...options,
        }),
        fakeProcessServices(),
      ),
    executeCliConfig: (
      config: Parameters<typeof runtime.executeCliConfig>[0],
      context: Parameters<typeof runtime.executeCliConfig>[1],
      options: WithoutSession<
        Parameters<typeof runtime.executeCliConfig>[2]
      > = {},
    ) =>
      Effect.provide(
        runtime.executeCliConfig(config, context, {
          session: Effect.succeed(testDefaultSession()),
          runtime: testRuntime(),
          lifecycle: installedHost().platform.lifecycle,
          agentRuns: agentRunsFake,
          ...options,
        }),
        fakeProcessServices(),
      ),
    executeCliToolUseConfig: (
      config: Parameters<typeof runtime.executeCliToolUseConfig>[0],
      context: Parameters<typeof runtime.executeCliToolUseConfig>[1],
      options: WithoutSession<
        Parameters<typeof runtime.executeCliToolUseConfig>[2]
      > = {},
    ) =>
      Effect.provide(
        runtime.executeCliToolUseConfig(config, context, {
          session: Effect.succeed(testDefaultSession()),
          runtime: testRuntime(),
          lifecycle: installedHost().platform.lifecycle,
          agentRuns: agentRunsFake,
          ...options,
        }),
        fakeProcessServices(),
      ),
  };
}

type LeaseOptions = {
  beforeLeaseRelease?: () => Effect.Effect<boolean | void, Error>;
  openWorkflowOutput?: RunAgentOptions['openWorkflowOutput'];
  session?: SessionHandle;
  onRunLeaseAcquired?: (runId: RunId) => void;
};

/**
 * Stubs runAgent to publish its lease options through `published` and then
 * hang until the test resolves it — the shape the shutdown-interrupt tests
 * drive.
 */
function stubHangingRun(published: Deferred.Deferred<LeaseOptions>): {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
} {
  let resolveRun!: (result: unknown) => void;
  let rejectRun!: (error: unknown) => void;
  mocks.runAgent.mockImplementation(async (request, options: LeaseOptions) => {
    Deferred.doneUnsafe(published, Effect.succeed(options));
    const runId = request.runId as RunId;
    const launchHandle = new RunHandle(
      {
        runId,
        identity: { kind: 'agent', agent: 'chat' },
        category: 'toolUse',
      },
      null,
    );
    const runs = options.session?.runs;
    // The launch's stop target is its run's roster fiber; the hanging
    // promise is the test's to resolve, as the run's own result is, and the
    // generation ends with it.
    let generation: { interruptUnsafe(): void } | undefined;
    if (runs) {
      runs.track(launchHandle);
      generation = admitInterruptibleRun(runs, runId, () => undefined);
    }
    try {
      return await new Promise((resolve, reject) => {
        resolveRun = resolve;
        rejectRun = reject;
      });
    } finally {
      generation?.interruptUnsafe();
      if (runs && runs.getHandle(runId) === launchHandle) {
        if (runs) untrackRun(runs, runId);
      }
    }
  });
  return {
    resolve: (result: unknown) => resolveRun(result),
    reject: (error: unknown) => rejectRun(error),
  };
}

/** Observe the session's terminal artifact drain. */
async function spyOnArtifactFlush() {
  const flushSpy = vi
    .spyOn(testDefaultSession(), 'settlePublications')
    .mockReturnValue(Effect.void);
  return { flushSpy };
}

/**
 * The reflection snapshot a resumable run carries on its aggregate. Only its
 * presence is read here; the workflow command owns the rule that reads its
 * fields.
 */
function reflectionSnapshot(): FlowSnapshotPayload {
  return {
    family: 'reflection',
    runtime: {
      phase: 'initial',
      round: 0,
      turn: 0,
      continuationIndex: 0,
      modelId: 'deepseekT',
      modelCompatibilityKey: null,
      lastError: null,
      declinedRoutes: [],
    },
    state: {
      totalRounds: 4,
      workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
    },
  };
}

async function stubExecuteCliDeps(): Promise<void> {
  vi.clearAllMocks();
  mocks.close.mockReturnValue(Effect.void);
  mocks.detachRunProgressRenderer.mockReturnValue(undefined);
  // The projection's detach is an Effect the run drains, not a promise.
  mocks.detachSessionProgressProjection.mockReturnValue(Effect.void);
  mocks.attachRunProgressRenderer.mockReturnValue(
    mocks.detachRunProgressRenderer,
  );
  mocks.attachWorkflowPlainOutput.mockReturnValue(
    mocks.detachWorkflowPlainOutput,
  );
  mocks.createHeadlessCliHostInteractions.mockReturnValue({
    emit: mocks.emit,
    pending: vi.fn(() => []),
    resolve: vi.fn(() => false),
    cancel: vi.fn(),
    dispose: mocks.disposeHostInteractions,
  });
  mocks.createCliRuntimeHost.mockReturnValue({
    emit: mocks.emit,
    attachRunProgressRenderer: mocks.attachRunProgressRenderer,
    prepareInteractivePrompt: mocks.prepareInteractivePrompt,
    close: mocks.close,
  });
  mocks.readCliRunOutcomeState.mockResolvedValue({
    outcome: 'completed',
    outcomePersisted: true,
  });
  mocks.deriveResumability.mockResolvedValue({
    kind: 'checkpoint',
    snapshot: reflectionSnapshot(),
  });
  mocks.releaseRunLeaseAfterArtifacts.mockResolvedValue(undefined);
  // The CLI shutdown drain is the session's one exit choreography; the suite
  // observes it through the same spy the deleted host-local shim fed.
  const { SessionHandle } = await import('@agent/runtime/SessionHandle');
  vi.spyOn(SessionHandle.prototype, 'releaseRunLease').mockImplementation(
    function (this: unknown, runId) {
      return Effect.tryPromise({
        try: () => mocks.releaseRunLeaseAfterArtifacts(this, runId),
        catch: (error) => error as Error,
      });
    },
  );
  mocks.finalizeRun.mockResolvedValue({ ok: true });
  mocks.runAgent.mockImplementation(async (_request, options) => {
    options.onRunLeaseAcquired?.('exec-1' as RunId);
    return COMPLETED_RUN;
  });
}

/** Queues one cancelled, persisted outcome read for the next resolution. */
function mockCancelledOutcome(): void {
  mocks.readCliRunOutcomeState.mockResolvedValueOnce({
    outcome: RUN_OUTCOME.CANCELLED,
    outcomePersisted: true,
  });
}

/** Loads shutdown tests against the host that owns the current session. */
async function loadExecuteCliOnInstalledHost() {
  const host = installedHost();
  const { executeCliRequest } = await loadExecuteCli();
  return { platform: host.platform, executeCliRequest };
}

describe('executeCliRequest', () => {
  beforeEach(async () => {
    await stubExecuteCliDeps();
    await installFreshDefaultSession();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect.each(['text', 'json'] as const)(
    'does not attach the CLI progress projection for %s output',
    (outputFormat) =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const { attachCliSessionProgressProjection } = yield* Effect.promise(
          () => import('@cli/runtime/sessionProgressSubscription'),
        );
        const attachProjection = vi.mocked(attachCliSessionProgressProjection);
        const request = baseRequest();

        yield* executeCliRequest(request, cliContext({ outputFormat }));

        expect(attachProjection).not.toHaveBeenCalled();
        expect(mocks.detachSessionProgressProjection).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'attaches the CLI progress projection for NDJSON output before the run starts',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const { attachCliSessionProgressProjection } = yield* Effect.promise(
          () => import('@cli/runtime/sessionProgressSubscription'),
        );
        const attachProjection = vi.mocked(attachCliSessionProgressProjection);
        const request = baseRequest();

        yield* executeCliRequest(
          request,
          cliContext({ outputFormat: 'ndjson' }),
        );

        expect(attachProjection).toHaveBeenCalledTimes(1);
        // The writer slot: the projection defaults to the NDJSON stdout sink.
        expect(attachProjection.mock.calls[0]?.[1]).toBeUndefined();
        expect(mocks.runAgent).toHaveBeenCalledTimes(1);
        expect(attachProjection.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.runAgent.mock.invocationCallOrder[0] ??
            Number.POSITIVE_INFINITY,
        );
        expect(mocks.detachSessionProgressProjection).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect.each([
    { policy: 'never', overrides: {} },
    { policy: 'ask', overrides: { approvalPolicy: 'ask' } },
  ] as const)(
    'marks headless $policy runs as approval-unavailable for agent run',
    ({ overrides }) =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const request = baseRequest();

        yield* executeCliRequest(request, cliContext(overrides));

        expect(mocks.runAgent).toHaveBeenCalledWith(
          request,
          expect.objectContaining({
            approvalPromptsUnavailable: true,
          }),
        );
      }),
  );

  it.effect('keeps yolo runs approval-available for agent run', () =>
    Effect.gen(function* () {
      const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
      const request = baseRequest();

      yield* executeCliRequest(request, cliContext({ approvalPolicy: 'yolo' }));

      expect(testDefaultSession().approvalPolicy).toBe('yolo');
      expect(mocks.runAgent).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          approvalPromptsUnavailable: false,
        }),
      );
    }),
  );

  it.effect(
    'reports outcome read failures without rejecting a successful run',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const readError = new Error('metadata read failed');
        mocks.readCliRunOutcomeState.mockImplementationOnce(
          async (
            _session: unknown,
            result: { readonly outcome: string },
            reportReadFailure: (error: Error) => void,
          ) => {
            reportReadFailure(readError);
            return { outcome: result.outcome, outcomePersisted: false };
          },
        );

        expect(
          yield* executeCliRequest(baseRequest(), cliContext()),
        ).toMatchObject({
          ok: true,
          result: { outcome: 'completed' },
        });
        expect(mocks.emit).toHaveBeenCalledWith('requestShowError', {
          message: 'metadata read failed',
        });
      }),
  );

  it.effect('drains the session artifacts after the run', () =>
    Effect.gen(function* () {
      const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
      const request = baseRequest();
      const { flushSpy } = yield* Effect.promise(spyOnArtifactFlush);
      const callOrder: string[] = [];
      flushSpy.mockImplementation(() =>
        Effect.sync(() => {
          callOrder.push('flush');
        }),
      );
      mocks.runAgent.mockImplementationOnce(async () => {
        callOrder.push('runAgent');
        return {
          outcome: 'completed',
          output: { category: 'toolUse', response: '', files: [] },
          runId: 'exec-1',
        };
      });

      yield* executeCliRequest(request, cliContext());

      expect(callOrder).toEqual(['runAgent', 'flush']);
    }),
  );

  it.effect('drains session artifacts even when the run throws', () =>
    Effect.gen(function* () {
      const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
      const request = baseRequest();
      const { flushSpy } = yield* Effect.promise(spyOnArtifactFlush);
      mocks.runAgent.mockRejectedValueOnce(new AgentError('boom'));

      // #7645: a classified run failure resolves to a non-zero exit code
      // instead of rethrowing — otherwise it reaches bin/texra.ts's crash
      // handler and gets misreported as an unexpected crash (double-printed
      // message + a false "please report it" line).
      const result = yield* executeCliRequest(request, cliContext());

      expect(result).toEqual({ ok: false, exitCode: CliExitCode.AgentError });
      expect(mocks.emit).toHaveBeenCalledWith('requestShowError', {
        message: 'boom',
      });
      expect(flushSpy).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect(
    'rethrows a non-AgentError rejection instead of swallowing it into an exit code',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const request = baseRequest();
        const { flushSpy } = yield* Effect.promise(spyOnArtifactFlush);
        // An unclassified failure (e.g. registerRun disk I/O,
        // workspaceState.update) is genuinely unexpected — it must keep
        // propagating so bin/texra.ts's crash handler reports it, instead of
        // being swallowed into a bare non-zero exit with no stderr. The defect
        // enters through the injected launch stand-in.
        const defectLaunch: typeof agentRunsFake = {
          ...agentRunsFake,
          launch: () => Effect.die(new Error('disk full')),
        };

        const error = yield* Effect.flip(
          executeCliRequest(request, cliContext(), { agentRuns: defectLaunch }),
        );
        expect(error.message).toContain('disk full');

        // Cleanup still runs via `finally` even though the error propagates.
        expect(flushSpy).toHaveBeenCalledTimes(1);
        expect(mocks.close).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect(
    'preserves a run failure when the final artifact flush also fails',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const { flushSpy } = yield* Effect.promise(spyOnArtifactFlush);
        const runError = new Error('provider transport failed');
        const flushError = new Error('transcript flush failed');
        mocks.runAgent.mockRejectedValueOnce(runError);
        flushSpy.mockReturnValueOnce(Effect.fail(flushError));

        const rejection = yield* Effect.flip(
          executeCliRequest(baseRequest(), cliContext()),
        );

        expect(rejection).toEqual(
          expect.objectContaining({
            errors: [runError, flushError],
            message:
              'CLI run failed and its final artifacts could not be persisted',
          }),
        );
        expect(mocks.close).toHaveBeenCalledOnce();
      }),
  );

  it.effect(
    'does not repeat an error already presented before lifecycle startup',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        mocks.runAgent.mockImplementationOnce(async () => {
          const hooks =
            mocks.createHeadlessCliHostInteractions.mock.calls[0]?.[3];
          hooks.emit('requestShowError', { message: 'Agent not found.' });
          throw new AgentError('Agent not found.');
        });

        expect(yield* executeCliRequest(baseRequest(), cliContext())).toEqual({
          ok: false,
          exitCode: CliExitCode.AgentError,
        });

        expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('requestShowError', {
          message: 'Agent not found.',
        });
      }),
  );

  // it.live for the shutdown choreography below: the run is forked in-fiber,
  // but runShutdown drives the lifecycle host's real-clock phase deadline and
  // its handler settles on the process runtime.
  it.live.each([
    { label: 'fresh', kind: 'fresh' },
    { label: 'resumed', kind: 'resume' },
  ] as const)(
    'marks $label owned runs interrupted during platform shutdown',
    ({ kind }) =>
      Effect.gen(function* () {
        const { platform, executeCliRequest } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        const { flushSpy } = yield* Effect.promise(spyOnArtifactFlush);
        const killSpy = vi.spyOn(testDefaultSession().runs, 'stop');
        mocks.releaseRunLeaseAfterArtifacts.mockImplementationOnce(
          async (session, runId) =>
            Effect.runPromise(session.settlePublications(runId)),
        );
        let settleRecoveryWrite!: () => void;
        const recoveryWrite = new Promise<void>((resolve) => {
          settleRecoveryWrite = resolve;
        });
        const finalized = yield* Deferred.make<void>();
        const onInterruptedRunFinalized = vi.fn(() => {
          Deferred.doneUnsafe(finalized, Effect.void);
          return recoveryWrite;
        });
        const published = yield* Deferred.make<LeaseOptions>();
        const hangingRun = stubHangingRun(published);

        const run = yield* Effect.forkChild(
          executeCliRequest(baseRequest(kind), cliContext(), {
            onInterruptedRunFinalized,
          }),
        );
        const leaseOptions = yield* Deferred.await(published);
        // The stub resumes this fiber synchronously, so one macrotask lets the
        // rest of the stub (the tracked launch handle) run first.
        yield* settle;
        expect(leaseOptions.onRunLeaseAcquired).toBeDefined();
        const shutdown = yield* Effect.forkChild(
          platform.lifecycle.runShutdown,
          { startImmediately: true },
        );
        yield* settle;
        expect(mocks.finalizeRun).not.toHaveBeenCalled();
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
        yield* settle;
        expect(killSpy).toHaveBeenCalledExactlyOnceWith('exec-1', {
          detachActiveChildren: false,
        });
        expect(mocks.releaseRunLeaseAfterArtifacts).not.toHaveBeenCalled();

        mockCancelledOutcome();
        hangingRun.resolve(COMPLETED_RUN);
        yield* Deferred.await(finalized);
        yield* settle;
        expect(onInterruptedRunFinalized).toHaveBeenCalledOnce();
        let shutdownResolved = false;
        shutdown.addObserver(() => {
          shutdownResolved = true;
        });
        yield* settle;
        expect(shutdownResolved).toBe(false);
        settleRecoveryWrite();
        yield* Fiber.join(shutdown);
        expect(mocks.releaseRunLeaseAfterArtifacts).toHaveBeenCalledOnce();
        expect(flushSpy).toHaveBeenCalled();
        expect(mocks.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: 'exec-1',
            outcome: RUN_OUTCOME.CANCELLED,
          }),
        );
        expect(mocks.finalizeRun.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.releaseRunLeaseAfterArtifacts.mock.invocationCallOrder[0] ??
            Number.POSITIVE_INFINITY,
        );
        expect(onInterruptedRunFinalized).toHaveBeenCalledExactlyOnceWith(
          'exec-1',
        );
        expect(
          mocks.releaseRunLeaseAfterArtifacts.mock.invocationCallOrder[0],
        ).toBeLessThan(
          onInterruptedRunFinalized.mock.invocationCallOrder[0] ??
            Number.POSITIVE_INFINITY,
        );
        expect(yield* Fiber.join(run)).toEqual({
          ok: true,
          outcomePersisted: true,
          result: {
            outcome: 'cancelled',
            output: { category: 'toolUse', response: '', files: [] },
            runId: 'exec-1',
          },
        });
        expect(mocks.finalizeRun).toHaveBeenCalledOnce();
      }),
  );

  it.live(
    'does not advertise signal recovery before a flow checkpoint exists',
    () =>
      Effect.gen(function* () {
        const { platform, executeCliRequest } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        mocks.deriveResumability.mockResolvedValueOnce({
          kind: 'none',
          outcome: RUN_OUTCOME.CANCELLED,
        });
        const onInterruptedRunFinalized = vi.fn();
        const published = yield* Deferred.make<LeaseOptions>();
        const hangingRun = stubHangingRun(published);

        const run = yield* Effect.forkChild(
          executeCliRequest(baseRequest(), cliContext(), {
            onInterruptedRunFinalized,
          }),
        );
        const leaseOptions = yield* Deferred.await(published);
        yield* settle;
        expect(leaseOptions.onRunLeaseAcquired).toBeDefined();
        const shutdown = yield* Effect.forkChild(
          platform.lifecycle.runShutdown,
          { startImmediately: true },
        );
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
        mockCancelledOutcome();
        hangingRun.resolve(COMPLETED_RUN);

        yield* Fiber.join(shutdown);
        yield* Fiber.join(run);

        expect(mocks.deriveResumability).toHaveBeenCalledExactlyOnceWith(
          'exec-1',
          expect.anything(),
        );
        expect(onInterruptedRunFinalized).not.toHaveBeenCalled();
      }),
  );

  // The pre-checkpoint shutdown bound is the lifecycle host's per-phase
  // join-with-deadline; its regression pin lives in LifecycleHost.vitest.ts.

  it.live('forwards a failed shutdown drain to the runtime release hook', () =>
    Effect.gen(function* () {
      const { platform, executeCliRequest } = yield* Effect.promise(
        loadExecuteCliOnInstalledHost,
      );
      const drainError = new Error('snapshot drain failed');
      mocks.releaseRunLeaseAfterArtifacts.mockRejectedValueOnce(drainError);
      const published = yield* Deferred.make<LeaseOptions>();
      const hangingRun = stubHangingRun(published);

      const run = yield* Effect.forkChild(
        executeCliRequest(baseRequest(), cliContext(), {}),
      );
      const leaseOptions = yield* Deferred.await(published);
      yield* settle;
      expect(leaseOptions).toBeDefined();
      leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
      const shutdown = yield* Effect.forkChild(platform.lifecycle.runShutdown, {
        startImmediately: true,
      });

      expect(
        yield* Effect.flip(leaseOptions.beforeLeaseRelease?.() ?? Effect.void),
      ).toBe(drainError);
      hangingRun.resolve(COMPLETED_RUN);
      yield* Fiber.join(shutdown);
      yield* Fiber.join(run);
    }),
  );

  it.live(
    'cancels launch preparation when shutdown precedes run registration',
    () =>
      Effect.gen(function* () {
        const { platform, executeCliRequest } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        const launch = yield* Deferred.make<void>();
        mocks.runAgent.mockImplementationOnce(
          async (request: { runId: RunId }, options: LeaseOptions) => {
            const runId = request.runId;
            // The launch's fiber is its stop: shutdown interrupts the run by
            // id, which fails the launch the way a real preparation unwinds.
            let rejectRun!: (error: unknown) => void;
            const runs = options.session?.runs;
            if (runs)
              admitInterruptibleRun(runs, runId, () => {
                rejectRun(new DOMException('Launch stopped.', 'AbortError'));
              });
            try {
              return await new Promise((_resolve, reject) => {
                rejectRun = reject;
                // Published once the stop target is live: the gate resumes
                // the test fiber synchronously and its shutdown stops the
                // launch.
                Deferred.doneUnsafe(launch, Effect.void);
              });
            } finally {
              if (runs) untrackRun(runs, runId);
            }
          },
        );

        const run = yield* Effect.forkChild(
          executeCliRequest(baseRequest(), cliContext(), {}),
        );
        yield* Deferred.await(launch);
        yield* settle;

        yield* platform.lifecycle.runShutdown;
        expect(yield* Fiber.join(run)).toEqual({
          ok: false,
          exitCode: CliExitCode.Interrupted,
        });
        expect(mocks.finalizeRun).not.toHaveBeenCalled();
      }),
  );

  it.live(
    'preserves a terminal outcome when shutdown cannot interrupt the finished run',
    () =>
      Effect.gen(function* () {
        const { platform, executeCliRequest } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        vi.spyOn(testDefaultSession().runs, 'stop').mockReturnValue({
          accepted: () => false,
          settlement: Effect.void,
        });
        const published = yield* Deferred.make<LeaseOptions>();
        const hangingRun = stubHangingRun(published);
        const run = yield* Effect.forkChild(
          executeCliRequest(baseRequest(), cliContext(), {}),
        );
        const leaseOptions = yield* Deferred.await(published);
        yield* settle;
        expect(leaseOptions).toBeDefined();
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);

        const shutdown = yield* Effect.forkChild(
          platform.lifecycle.runShutdown,
          { startImmediately: true },
        );
        hangingRun.resolve(COMPLETED_RUN);
        yield* Fiber.join(shutdown);
        yield* Fiber.join(run);

        expect(mocks.finalizeRun).not.toHaveBeenCalled();
        expect(mocks.releaseRunLeaseAfterArtifacts).not.toHaveBeenCalled();
      }),
  );

  it.live(
    'denies workflow output publication after shutdown interruption commits',
    () =>
      Effect.gen(function* () {
        const { platform, executeCliRequest } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        const published = yield* Deferred.make<LeaseOptions>();
        const hangingRun = stubHangingRun(published);
        let publicationCommitted: boolean | undefined;
        const run = yield* Effect.forkChild(
          executeCliRequest(baseRequest(), cliContext(), {
            openWorkflowOutput: (
              _result,
              _agentDefaultOutputFiles,
              tryCommitPublication,
            ) =>
              Effect.sync(() => {
                publicationCommitted = tryCommitPublication();
              }),
          }),
        );
        const leaseOptions = yield* Deferred.await(published);
        yield* settle;
        expect(leaseOptions).toBeDefined();

        const shutdown = yield* Effect.forkChild(
          platform.lifecycle.runShutdown,
          { startImmediately: true },
        );
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
        yield* settle;
        yield* leaseOptions.openWorkflowOutput?.(COMPLETED_WORKFLOW_RUN, []) ??
          Effect.void;
        mockCancelledOutcome();
        hangingRun.resolve(COMPLETED_WORKFLOW_RUN);

        yield* Fiber.join(shutdown);
        expect(yield* Fiber.join(run)).toMatchObject({
          ok: true,
          result: { outcome: RUN_OUTCOME.CANCELLED },
        });
        expect(publicationCommitted).toBe(false);
        expect(mocks.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: 'exec-1',
            outcome: RUN_OUTCOME.CANCELLED,
          }),
        );
      }),
  );

  it.live(
    'preserves the workflow verdict after output publication commits',
    () =>
      Effect.gen(function* () {
        const { platform, executeCliRequest } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        const killSpy = vi.spyOn(testDefaultSession().runs, 'stop');
        const published = yield* Deferred.make<LeaseOptions>();
        const hangingRun = stubHangingRun(published);
        let publicationCommitted: boolean | undefined;
        const run = yield* Effect.forkChild(
          executeCliRequest(baseRequest(), cliContext(), {
            openWorkflowOutput: (
              _result,
              _agentDefaultOutputFiles,
              tryCommitPublication,
            ) =>
              Effect.sync(() => {
                publicationCommitted = tryCommitPublication();
              }),
          }),
        );
        const leaseOptions = yield* Deferred.await(published);
        yield* settle;
        expect(leaseOptions).toBeDefined();
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
        yield* settle;
        yield* leaseOptions.openWorkflowOutput?.(COMPLETED_WORKFLOW_RUN, []) ??
          Effect.void;

        const shutdown = yield* Effect.forkChild(
          platform.lifecycle.runShutdown,
          { startImmediately: true },
        );
        hangingRun.resolve(COMPLETED_WORKFLOW_RUN);

        yield* Fiber.join(shutdown);
        expect(yield* Fiber.join(run)).toMatchObject({
          ok: true,
          result: { outcome: RUN_OUTCOME.COMPLETED },
        });
        expect(publicationCommitted).toBe(true);
        expect(killSpy).not.toHaveBeenCalled();
        expect(mocks.finalizeRun).not.toHaveBeenCalled();
      }),
  );

  it.live(
    'does not convert a committed output failure to cancelled by a later shutdown',
    () =>
      Effect.gen(function* () {
        const { platform, executeCliRequest } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        // Imported dynamically (like the lease test below) so the `instanceof`
        // check in executeCli.ts sees the same module instance even after an
        // earlier test's `vi.resetModules()` in this file.
        const { AgentError: RuntimeAgentError } = yield* Effect.promise(
          () => import('@common/errors'),
        );
        const killSpy = vi.spyOn(testDefaultSession().runs, 'stop');
        const outputFailure = new Error(
          'Workflow completed without generated outputs; nothing was copied to out.',
        );
        let publicationCommitted: boolean | undefined;
        let outputResolutionFailed = false;
        const outputFailed = yield* Deferred.make<void>();
        let releaseRun!: () => void;
        const runGate = new Promise<void>((resolve) => {
          releaseRun = resolve;
        });
        mocks.runAgent.mockImplementationOnce(
          async (_request: unknown, options: LeaseOptions) => {
            options.onRunLeaseAcquired?.('exec-1' as RunId);
            try {
              await testRuntime().runPromise(
                options.openWorkflowOutput?.(COMPLETED_WORKFLOW_RUN, []) ??
                  Effect.void,
              );
            } catch {
              outputResolutionFailed = true;
              Deferred.doneUnsafe(outputFailed, Effect.void);
            }
            await runGate;
            // runAgent classifies the host output failure before it reaches the
            // CLI boundary. Emit the same prefixed AgentError finalizeFailedRun
            // throws so this test pins the production message, not the mock's raw
            // copy error.
            throw new RuntimeAgentError(
              `Error executing agent polish: ${outputFailure.message}`,
            );
          },
        );

        const run = yield* Effect.forkChild(
          executeCliRequest(baseRequest(), cliContext(), {
            openWorkflowOutput: (
              _result,
              _agentDefaultOutputFiles,
              tryCommitPublication,
            ) =>
              Effect.sync(() => {
                publicationCommitted = tryCommitPublication();
              }).pipe(Effect.andThen(Effect.fail(outputFailure))),
          }),
        );

        yield* Deferred.await(outputFailed);
        yield* settle;
        expect(outputResolutionFailed).toBe(true);
        const shutdown = yield* Effect.forkChild(
          platform.lifecycle.runShutdown,
          { startImmediately: true },
        );
        yield* settle;
        expect(killSpy).not.toHaveBeenCalled();

        releaseRun();
        yield* Fiber.join(shutdown);
        expect(yield* Fiber.join(run)).toEqual({
          ok: false,
          exitCode: CliExitCode.AgentError,
        });
        expect(publicationCommitted).toBe(true);
        expect(mocks.finalizeRun).not.toHaveBeenCalled();
        expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('requestShowError', {
          message: `Error executing agent polish: ${outputFailure.message}`,
        });
      }),
  );

  it.live(
    'does not report a shutdown drain that fails because the claim is already lost',
    () =>
      Effect.gen(function* () {
        const { platform, executeCliRequest } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        // Imported dynamically (matching the module above) so the `instanceof`
        // check in executeCli.ts sees the same module instance even after an
        // earlier test's `vi.resetModules()` in this file.
        const { DatabaseNotOwner } = yield* Effect.promise(
          () => import('@shared/session/database'),
        );
        mocks.releaseRunLeaseAfterArtifacts.mockRejectedValueOnce(
          new DatabaseNotOwner({
            // The fixture's run id is not a canonical one, so the key is
            // written directly: only its type matters to the drain.
            aggregateId: JSON.stringify(['run', 'exec-1']) as AggregateId,
            ownerId: null,
            closed: false,
          }),
        );
        const published = yield* Deferred.make<LeaseOptions>();
        const hangingRun = stubHangingRun(published);

        const run = yield* Effect.forkChild(
          executeCliRequest(baseRequest(), cliContext(), {}),
        );
        const leaseOptions = yield* Deferred.await(published);
        yield* settle;
        expect(leaseOptions).toBeDefined();
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
        const shutdown = yield* Effect.forkChild(
          platform.lifecycle.runShutdown,
          { startImmediately: true },
        );

        expect(yield* leaseOptions.beforeLeaseRelease?.() ?? Effect.void).toBe(
          false,
        );
        hangingRun.resolve(COMPLETED_RUN);
        yield* Fiber.join(shutdown);
        yield* Fiber.join(run);
      }),
  );

  it.live('closes the runtime host when shutdown finalization fails', () =>
    Effect.gen(function* () {
      const { platform, executeCliRequest } = yield* Effect.promise(
        loadExecuteCliOnInstalledHost,
      );
      const persistenceError = new Error('terminal metadata disk full');
      mocks.finalizeRun.mockImplementation(async (input) => {
        input.report?.(
          new Error(
            `Failed to persist ${input.outcome} terminal state for run ${input.runId}: terminal metadata disk full`,
            { cause: persistenceError },
          ),
        );
        return { ok: false, error: persistenceError, outcomePersisted: false };
      });
      const published = yield* Deferred.make<LeaseOptions>();
      const hangingRun = stubHangingRun(published);

      const onInterruptedRunFinalized = vi.fn();
      const run = yield* Effect.forkChild(
        executeCliRequest(baseRequest(), cliContext(), {
          onInterruptedRunFinalized,
        }),
      );
      const leaseOptions = yield* Deferred.await(published);
      yield* settle;
      expect(mocks.runAgent).toHaveBeenCalledOnce();
      leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
      const shutdown = yield* Effect.forkChild(platform.lifecycle.runShutdown, {
        startImmediately: true,
      });
      yield* settle;
      expect(mocks.emit).not.toHaveBeenCalled();
      mockCancelledOutcome();
      hangingRun.resolve(COMPLETED_RUN);
      yield* Fiber.join(shutdown);
      expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('requestShowError', {
        message:
          'Failed to persist cancelled terminal state for run exec-1: terminal metadata disk full',
      });

      expect(yield* Fiber.join(run)).toEqual({
        ok: true,
        outcomePersisted: true,
        result: {
          outcome: 'cancelled',
          output: { category: 'toolUse', response: '', files: [] },
          runId: 'exec-1',
        },
      });
      expect(mocks.finalizeRun).toHaveBeenCalledOnce();
      expect(mocks.emit).toHaveBeenCalledTimes(1);
      expect(mocks.close).toHaveBeenCalledTimes(1);
      expect(onInterruptedRunFinalized).not.toHaveBeenCalled();
    }),
  );

  it.live(
    'still presents a classified run failure when shutdown finalization also failed',
    () =>
      Effect.gen(function* () {
        const { platform, executeCliRequest } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        // Imported dynamically (like the tests above) so the `instanceof`
        // check in executeCli.ts sees the same module instance.
        const { AgentError: RuntimeAgentError } = yield* Effect.promise(
          () => import('@common/errors'),
        );
        // The production `emit` wrapper, which the default stub replaces: it
        // is the thing that sets `failurePresented`, so only with it installed
        // can this suite see whether a finalization notice claims the run's
        // own failure presentation.
        mocks.createHeadlessCliHostInteractions.mockImplementationOnce(
          (_session, _runtime, _context, hooks) => ({
            emit: hooks.emit,
            dispose: mocks.disposeHostInteractions,
          }),
        );
        mocks.finalizeRun.mockImplementation(async (input) => {
          input.report?.(new Error('terminal metadata disk full'));
          return { ok: false, outcomePersisted: false };
        });
        const published = yield* Deferred.make<LeaseOptions>();
        const hangingRun = stubHangingRun(published);

        const run = yield* Effect.forkChild(
          executeCliRequest(baseRequest(), cliContext(), {}),
        );
        const leaseOptions = yield* Deferred.await(published);
        yield* settle;
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
        const shutdown = yield* Effect.forkChild(
          platform.lifecycle.runShutdown,
          { startImmediately: true },
        );
        yield* settle;
        // The drain runs under the lease, before the launch settles: this is
        // the instant at which its failure notice used to claim the run's own
        // presentation and suppress the message below.
        expect(yield* leaseOptions.beforeLeaseRelease?.() ?? Effect.void).toBe(
          true,
        );
        hangingRun.reject(
          new RuntimeAgentError('Error executing agent chat: boom'),
        );
        yield* Fiber.join(shutdown);

        expect(yield* Fiber.join(run)).toEqual({
          ok: false,
          exitCode: CliExitCode.AgentError,
        });
        expect(mocks.emit).toHaveBeenCalledTimes(2);
        expect(mocks.emit).toHaveBeenCalledWith('requestShowError', {
          message: 'terminal metadata disk full',
        });
        expect(mocks.emit).toHaveBeenCalledWith('requestShowError', {
          message: 'Error executing agent chat: boom',
        });
      }),
  );

  it.live('removes the shutdown status hook after owned runs finish', () =>
    Effect.gen(function* () {
      const { platform, executeCliRequest } = yield* Effect.promise(
        loadExecuteCliOnInstalledHost,
      );
      const request = baseRequest();

      yield* executeCliRequest(request, cliContext(), {});
      mocks.finalizeRun.mockClear();
      yield* platform.lifecycle.runShutdown;

      expect(mocks.finalizeRun).not.toHaveBeenCalled();
    }),
  );
});

describe('executeCliConfig', () => {
  beforeEach(async () => {
    await stubExecuteCliDeps();
    await installFreshDefaultSession();
  });

  // it.live for the two shutdown tests below: the run is forked in-fiber, but
  // runShutdown drives the lifecycle host's real-clock phase deadline and its
  // handler settles on the process runtime.
  it.live(
    'prints a complete resume command after interrupted tool-use recovery is available',
    () =>
      Effect.gen(function* () {
        const { platform } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        const { executeCliToolUseConfig } =
          yield* Effect.promise(loadExecuteCli);
        const context = cliContext({
          approvalPolicy: 'yolo',
          outputFormat: 'ndjson',
          skillSourceOptions: {
            includeInterop: true,
            additionalPaths: ['/tmp/skill path'],
          },
        });
        const published = yield* Deferred.make<LeaseOptions>();
        const hangingRun = stubHangingRun(published);
        let settleRecoveryWrite!: () => void;
        const recoveryWrite = new Promise<void>((resolve) => {
          settleRecoveryWrite = resolve;
        });
        const noticeStarted = yield* Deferred.make<void>();
        mocks.writeTextStderrAndWait.mockImplementationOnce(() => {
          Deferred.doneUnsafe(noticeStarted, Effect.void);
          return recoveryWrite;
        });

        const run = yield* Effect.forkChild(
          executeCliToolUseConfig(toolUseConfig(), context, {
            stopAfterCycle: true,
          }),
        );
        const leaseOptions = yield* Deferred.await(published);
        yield* settle;
        expect(leaseOptions.onRunLeaseAcquired).toBeDefined();
        const shutdown = yield* Effect.forkChild(
          platform.lifecycle.runShutdown,
          { startImmediately: true },
        );
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
        mockCancelledOutcome();
        hangingRun.resolve(COMPLETED_RUN);

        yield* Deferred.await(noticeStarted);
        yield* settle;
        expect(mocks.writeTextStderrAndWait).toHaveBeenCalledOnce();
        let shutdownResolved = false;
        shutdown.addObserver(() => {
          shutdownResolved = true;
        });
        yield* settle;
        expect(shutdownResolved).toBe(false);
        settleRecoveryWrite();
        yield* Fiber.join(shutdown);
        expect(yield* Fiber.join(run)).toMatchObject({
          ok: true,
          exitCode: CliExitCode.Interrupted,
        });
        expect(mocks.writeTextStderrAndWait).toHaveBeenCalledExactlyOnceWith(
          "Resume this session with: texra resume exec-1 --cwd /tmp/project --approval-policy yolo --include-interop --source '/tmp/skill path'",
        );
      }),
  );

  it.live(
    'does not advertise recovery for invocation-owned temporary inputs',
    () =>
      Effect.gen(function* () {
        const { platform } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        const { executeCliToolUseConfig } =
          yield* Effect.promise(loadExecuteCli);
        const published = yield* Deferred.make<LeaseOptions>();
        const hangingRun = stubHangingRun(published);

        const run = yield* Effect.forkChild(
          executeCliToolUseConfig(toolUseConfig(), cliContext(), {
            recoveryInputIsDurable: false,
          }),
        );
        const leaseOptions = yield* Deferred.await(published);
        yield* settle;
        expect(leaseOptions.onRunLeaseAcquired).toBeDefined();
        const shutdown = yield* Effect.forkChild(
          platform.lifecycle.runShutdown,
          { startImmediately: true },
        );
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
        mockCancelledOutcome();
        hangingRun.resolve(COMPLETED_RUN);

        yield* Fiber.join(shutdown);
        yield* Fiber.join(run);
        expect(mocks.writeTextStderrAndWait).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'records each installed plugin by source and pinned commit in the CLI result',
    () =>
      Effect.gen(function* () {
        const commit = 'a'.repeat(40);
        yield* testDefaultSession().roots.globalState.update(
          GlobalStateKey.INSTALLED_PLUGINS,
          [
            {
              name: 'notes',
              source: 'https://github.com/example/notes.git',
              commit,
              path: '/home/me/.texra/plugins/notes',
              skills: ['/home/me/.texra/plugins/notes/skills'],
            },
          ],
        );
        const { AgentCategory } = yield* Effect.promise(
          () => import('@shared/schemas'),
        );
        const { executeCliToolUseConfig } =
          yield* Effect.promise(loadExecuteCli);
        mocks.runAgent.mockResolvedValueOnce({
          outcome: 'completed',
          output: {
            category: AgentCategory.ToolUse,
            response: 'Done.',
            files: [],
          },
          runId: 'exec-1',
        });
        mocks.readCliRunOutcomeState.mockResolvedValueOnce({
          outcome: 'completed',
          outcomePersisted: true,
        });
        const result = yield* executeCliToolUseConfig(
          toolUseConfig(),
          cliContext(),
          { stopAfterCycle: true },
        );

        expect(result).toMatchObject({
          ok: true,
          exitCode: 0,
          result: {
            outcome: 'completed',
            workingDirectory: '/tmp/project',
            output: { response: 'Done.' },
          },
        });
        if (result.ok) {
          // The result names each installed plugin by where it came from and
          // its pinned commit, never by the local checkout it was read from.
          expect(result.result.plugins).toEqual([
            {
              name: 'notes',
              source: 'https://github.com/example/notes.git',
              commit,
            },
          ]);
          expect(Object.keys(result.result)).toEqual([
            'outcome',
            'output',
            'runId',
            'plugins',
            'workingDirectory',
          ]);
        }
      }),
  );
});
