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
import type { FlowSnapshotPayload, RunId } from '@shared/schemas';
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
import { getDefaultUnavailableToolNames } from '@tools/registry';

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
    await import('@agent/runtime/SessionHandle');
  await Effect.runPromise(teardownDefaultSession());
  await Effect.runPromise(initializeDefaultSession({}));
}

async function installStoragePlatform(): Promise<void> {
  await installFakeHost(await createTempDirPlatform('texra-run-', tempDirs));
}

vi.mock('@agent/runtime/runAgent', async () => {
  const { Effect } = await import('effect');
  return {
    runAgent: (...args: unknown[]) =>
      Effect.tryPromise({
        try: () => mocks.runAgent(...args),
        catch: (error) => error,
      }),
  };
});

vi.mock('@agent/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage')>()),
  deriveResumability: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.deriveResumability(...args),
      catch: (error) => error,
    }),
  finalizeRun: (_session: unknown, input: unknown) =>
    Effect.tryPromise({
      try: () => mocks.finalizeRun(input),
      catch: (error) => error,
    }),
}));

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
  attachCliSessionProgressProjection: vi.fn(
    () => mocks.detachSessionProgressProjection,
  ),
}));

vi.mock('@cli/runtime/runProgressRenderer', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@cli/runtime/runProgressRenderer')
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

/** Tools the CLI runtime hides by default during agent run. */
const DEFAULT_RUNTIME_UNAVAILABLE_TOOLS = getDefaultUnavailableToolNames('cli');

/** A run program's options with the session the wrapper below supplies. */
type WithoutSession<O> = Omit<O, 'session'>;

async function loadExecuteCli() {
  const runtime = await import('@cli/runtime/executeCli');
  const { defaultSession } = await import('@agent/runtime/SessionHandle');
  // The commands thread `initCliPlatform`'s session in; here the process
  // default this file installs stands in for it.
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
          session: defaultSession(),
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
          session: defaultSession(),
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
          session: defaultSession(),
          ...options,
        }),
        fakeProcessServices(),
      ),
  };
}

type LeaseOptions = {
  beforeLeaseRelease?: () => Promise<boolean | void>;
  openWorkflowOutput?: RunAgentOptions['openWorkflowOutput'];
  onRun?: () => void;
  launchSignal?: AbortSignal;
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
} {
  let resolveRun!: (result: unknown) => void;
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
    launchHandle.attachInterruptHandler({ interrupt: () => undefined });
    options.session?.runs.track(launchHandle);
    try {
      return await new Promise((resolve) => {
        resolveRun = resolve;
      });
    } finally {
      if (options.session?.runs.getHandle(runId) === launchHandle) {
        options.session.runs.untrack(runId);
      }
    }
  });
  return { resolve: (result: unknown) => resolveRun(result) };
}

/** Observe the session's terminal artifact drain. */
async function spyOnArtifactFlush() {
  const { defaultSession } = await import('@agent/runtime/SessionHandle');
  const store = defaultSession().transcripts;
  const flushSpy = vi
    .spyOn(defaultSession(), 'flushArtifacts')
    .mockResolvedValue(undefined);
  return { store, flushSpy };
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
      pendingRetry: null,
      declinedRoutes: [],
    },
    references: { pendingIntents: [], pendingResponse: null },
    state: {
      currentRound: 0,
      totalRounds: 4,
      workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
      outputLocation: null,
      runStateSnapshot: { totalRounds: 4, totalResponseTimeMs: 0 },
      roundOutputs: [],
      continueRounds: true,
      endTurn: false,
    },
  };
}

async function stubExecuteCliDeps(): Promise<void> {
  vi.clearAllMocks();
  mocks.close.mockResolvedValue(undefined);
  mocks.detachRunProgressRenderer.mockReturnValue(undefined);
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
    emitApprovalBypassState: vi.fn(),
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
        expect(attachProjection.mock.calls[0]?.[1]).toBeUndefined();
        expect(mocks.runAgent).toHaveBeenCalledTimes(1);
        expect(attachProjection.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.runAgent.mock.invocationCallOrder[0] ??
            Number.POSITIVE_INFINITY,
        );
        expect(mocks.detachSessionProgressProjection).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect(
    'observes workflow-script children for every visible text run',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const request = {
          config: toolUseConfig(),
          runId: 'abcdef',
        } as CliRequest;

        yield* executeCliRequest(
          request,
          cliContext({ outputFormat: 'text', renderRunProgress: true }),
        );

        expect(mocks.attachWorkflowPlainOutput).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            runId: 'abcdef',
            writeLine: mocks.writeTextStderr,
          }),
        );
        expect(
          mocks.attachWorkflowPlainOutput.mock.invocationCallOrder[0],
        ).toBeLessThan(
          mocks.runAgent.mock.invocationCallOrder[0] ??
            Number.POSITIVE_INFINITY,
        );
        expect(mocks.attachRunProgressRenderer).toHaveBeenCalledTimes(1);
        expect(mocks.detachWorkflowPlainOutput).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect(
    'keeps workflow-script progress quiet when run progress is disabled',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const request = {
          config: {
            agent: 'proof-workflow',
            model: 'gpt54',
            agentCategory: 'workflow',
          },
          runId: 'abcdef',
        } as CliRequest;

        yield* executeCliRequest(
          request,
          cliContext({ outputFormat: 'text', renderRunProgress: false }),
        );

        expect(mocks.attachWorkflowPlainOutput).not.toHaveBeenCalled();
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
      const { defaultSession } = yield* Effect.promise(
        () => import('@agent/runtime/SessionHandle'),
      );
      const request = baseRequest();

      yield* executeCliRequest(request, cliContext({ approvalPolicy: 'yolo' }));

      expect(defaultSession().approvalPolicy).toBe('yolo');
      expect(mocks.runAgent).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          approvalPromptsUnavailable: false,
        }),
      );
    }),
  );

  it.effect('hides host-unavailable tools in CLI run', () =>
    Effect.gen(function* () {
      const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
      const request = baseRequest();

      yield* executeCliRequest(
        request,
        cliContext({ mode: 'interactive', approvalPolicy: 'ask' }),
      );

      expect(mocks.runAgent).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          approvalPromptsUnavailable: false,
          runtimeUnavailableTools: DEFAULT_RUNTIME_UNAVAILABLE_TOOLS,
        }),
      );
    }),
  );

  it.effect(
    'restores CLI host interactions before closing the runtime host',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const request = baseRequest();

        yield* executeCliRequest(request, cliContext());

        expect(mocks.disposeHostInteractions).toHaveBeenCalledTimes(1);
        expect(mocks.close).toHaveBeenCalledTimes(1);
        expect(
          mocks.disposeHostInteractions.mock.invocationCallOrder[0],
        ).toBeLessThan(
          mocks.close.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
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

  it.effect(
    'uses a persistent session and drains its artifacts after the run',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const request = baseRequest();
        const { store, flushSpy } = yield* Effect.promise(spyOnArtifactFlush);
        const callOrder: string[] = [];
        flushSpy.mockImplementation(async () => {
          callOrder.push('flush');
        });
        mocks.runAgent.mockImplementationOnce(async () => {
          callOrder.push('runAgent');
          return {
            outcome: 'completed',
            output: { category: 'toolUse', response: '', files: [] },
            runId: 'exec-1',
          };
        });

        yield* executeCliRequest(request, cliContext());

        expect(store.mode).toEqual({ kind: 'persistent' });
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
        // being swallowed into a bare non-zero exit with no stderr.
        const runtime = yield* Effect.promise(() => import('@agent/runtime'));
        vi.spyOn(runtime, 'runAgent').mockReturnValueOnce(
          Effect.die(new Error('disk full')),
        );

        const error = yield* Effect.flip(
          executeCliRequest(request, cliContext()),
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
        flushSpy.mockRejectedValueOnce(flushError);

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
    'resolves a classified run failure to a non-zero exit code without rethrowing or finalizing again',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const request = baseRequest();
        mocks.runAgent.mockImplementationOnce(
          async (
            _request: unknown,
            options: { readonly onRun?: () => void },
          ) => {
            options.onRun?.();
            throw new AgentError('provider boom');
          },
        );

        const result = yield* executeCliRequest(request, cliContext());

        expect(result).toEqual({ ok: false, exitCode: CliExitCode.AgentError });
        expect(mocks.finalizeRun).not.toHaveBeenCalled();
        expect(mocks.close).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect(
    'does not repeat an error already presented before lifecycle startup',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        mocks.runAgent.mockImplementationOnce(async () => {
          const hooks =
            mocks.createHeadlessCliHostInteractions.mock.calls[0]?.[1];
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
  // but runShutdown drives the lifecycle host's raw-setTimeout deadline and its
  // handler settles on the process runtime.
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
        const { defaultSession } = yield* Effect.promise(
          () => import('@agent/runtime/SessionHandle'),
        );
        const killSpy = vi.spyOn(defaultSession().runs, 'kill');
        mocks.releaseRunLeaseAfterArtifacts.mockImplementationOnce(
          async (session, runId) => session.flushArtifacts(runId),
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
        const shutdown = platform.lifecycle.runShutdown();
        yield* settle;
        expect(mocks.finalizeRun).not.toHaveBeenCalled();
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
        leaseOptions.onRun?.();
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
        void shutdown.then(() => {
          shutdownResolved = true;
        });
        yield* settle;
        expect(shutdownResolved).toBe(false);
        settleRecoveryWrite();
        yield* Effect.promise(() => shutdown);
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
        const shutdown = platform.lifecycle.runShutdown();
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
        leaseOptions.onRun?.();
        mockCancelledOutcome();
        hangingRun.resolve(COMPLETED_RUN);

        yield* Effect.promise(() => shutdown);
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
      const shutdown = platform.lifecycle.runShutdown();

      // beforeLeaseRelease is a Promise on the production option bag, so the
      // rejection assertion stays promise-shaped.
      yield* Effect.promise(() =>
        expect(leaseOptions.beforeLeaseRelease?.()).rejects.toBe(drainError),
      );
      hangingRun.resolve(COMPLETED_RUN);
      yield* Effect.promise(() => shutdown);
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
        const launch = yield* Deferred.make<AbortSignal | undefined>();
        mocks.runAgent.mockImplementationOnce(
          async (_request: unknown, options: LeaseOptions) => {
            await new Promise<void>((_resolve, reject) => {
              options.launchSignal?.addEventListener(
                'abort',
                () =>
                  reject(new DOMException('Launch interrupted.', 'AbortError')),
                { once: true },
              );
              // Published after the listener exists: the gate resumes the test
              // fiber synchronously and its shutdown aborts this signal.
              Deferred.doneUnsafe(launch, Effect.succeed(options.launchSignal));
            });
            return COMPLETED_RUN;
          },
        );

        const run = yield* Effect.forkChild(
          executeCliRequest(baseRequest(), cliContext(), {}),
        );
        const launchSignal = yield* Deferred.await(launch);
        yield* settle;
        expect(launchSignal).toBeDefined();

        yield* Effect.promise(() => platform.lifecycle.runShutdown());
        expect(yield* Fiber.join(run)).toEqual({
          ok: false,
          exitCode: CliExitCode.Interrupted,
        });
        expect(launchSignal?.aborted).toBe(true);
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
        const { defaultSession } = yield* Effect.promise(
          () => import('@agent/runtime/SessionHandle'),
        );
        vi.spyOn(defaultSession().runs, 'kill').mockReturnValue({
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
        leaseOptions.onRun?.();

        const shutdown = platform.lifecycle.runShutdown();
        hangingRun.resolve(COMPLETED_RUN);
        yield* Effect.promise(() => shutdown);
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
            openWorkflowOutput: (_result, tryCommitPublication) =>
              Effect.sync(() => {
                publicationCommitted = tryCommitPublication();
              }),
          }),
        );
        const leaseOptions = yield* Deferred.await(published);
        yield* settle;
        expect(leaseOptions).toBeDefined();

        const shutdown = platform.lifecycle.runShutdown();
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
        leaseOptions.onRun?.();
        yield* settle;
        yield* Effect.promise(async () =>
          leaseOptions.openWorkflowOutput?.(COMPLETED_WORKFLOW_RUN),
        );
        mockCancelledOutcome();
        hangingRun.resolve(COMPLETED_WORKFLOW_RUN);

        yield* Effect.promise(() => shutdown);
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
        const { defaultSession } = yield* Effect.promise(
          () => import('@agent/runtime/SessionHandle'),
        );
        const killSpy = vi.spyOn(defaultSession().runs, 'kill');
        const published = yield* Deferred.make<LeaseOptions>();
        const hangingRun = stubHangingRun(published);
        let publicationCommitted: boolean | undefined;
        const run = yield* Effect.forkChild(
          executeCliRequest(baseRequest(), cliContext(), {
            openWorkflowOutput: (_result, tryCommitPublication) =>
              Effect.sync(() => {
                publicationCommitted = tryCommitPublication();
              }),
          }),
        );
        const leaseOptions = yield* Deferred.await(published);
        yield* settle;
        expect(leaseOptions).toBeDefined();
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
        leaseOptions.onRun?.();
        yield* settle;
        yield* Effect.promise(async () =>
          leaseOptions.openWorkflowOutput?.(COMPLETED_WORKFLOW_RUN),
        );

        const shutdown = platform.lifecycle.runShutdown();
        hangingRun.resolve(COMPLETED_WORKFLOW_RUN);

        yield* Effect.promise(() => shutdown);
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
        const { defaultSession } = yield* Effect.promise(
          () => import('@agent/runtime/SessionHandle'),
        );
        // Imported dynamically (like the lease test below) so the `instanceof`
        // check in executeCli.ts sees the same module instance even after an
        // earlier test's `vi.resetModules()` in this file.
        const { AgentError: RuntimeAgentError } = yield* Effect.promise(
          () => import('@common/errors'),
        );
        const killSpy = vi.spyOn(defaultSession().runs, 'kill');
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
            options.onRun?.();
            try {
              await options.openWorkflowOutput?.(COMPLETED_WORKFLOW_RUN);
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
            openWorkflowOutput: (_result, tryCommitPublication) =>
              Effect.sync(() => {
                publicationCommitted = tryCommitPublication();
              }).pipe(Effect.andThen(Effect.fail(outputFailure))),
          }),
        );

        yield* Deferred.await(outputFailed);
        yield* settle;
        expect(outputResolutionFailed).toBe(true);
        const shutdown = platform.lifecycle.runShutdown();
        yield* settle;
        expect(killSpy).not.toHaveBeenCalled();

        releaseRun();
        yield* Effect.promise(() => shutdown);
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
    'does not report a shutdown drain that fails because the lease is already lost',
    () =>
      Effect.gen(function* () {
        const { platform, executeCliRequest } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        // Imported dynamically (matching the module above) so the `instanceof`
        // check in executeCli.ts sees the same module instance even after an
        // earlier test's `vi.resetModules()` in this file.
        const { RunLeaseLostError } = yield* Effect.promise(
          () => import('@agent/storage'),
        );
        mocks.releaseRunLeaseAfterArtifacts.mockRejectedValueOnce(
          new RunLeaseLostError('exec-1' as RunId),
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
        const shutdown = platform.lifecycle.runShutdown();

        yield* Effect.promise(() =>
          expect(leaseOptions.beforeLeaseRelease?.()).resolves.toBe(false),
        );
        hangingRun.resolve(COMPLETED_RUN);
        yield* Effect.promise(() => shutdown);
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
      const shutdown = platform.lifecycle.runShutdown();
      yield* settle;
      expect(mocks.emit).not.toHaveBeenCalled();
      mockCancelledOutcome();
      hangingRun.resolve(COMPLETED_RUN);
      yield* Effect.promise(() => shutdown);
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

  it.live('removes the shutdown status hook after owned runs finish', () =>
    Effect.gen(function* () {
      const { platform, executeCliRequest } = yield* Effect.promise(
        loadExecuteCliOnInstalledHost,
      );
      const request = baseRequest();

      yield* executeCliRequest(request, cliContext(), {});
      mocks.finalizeRun.mockClear();
      yield* Effect.promise(() => platform.lifecycle.runShutdown());

      expect(mocks.finalizeRun).not.toHaveBeenCalled();
    }),
  );
});

describe('executeCliConfig', () => {
  beforeEach(async () => {
    await stubExecuteCliDeps();
    await installFreshDefaultSession();
  });

  /** Stubs a completed tool-use run and drives executeCliToolUseConfig. */
  const runCompletedToolUseConfig = (resolvedOutcome: string) =>
    Effect.gen(function* () {
      const { AgentCategory } = yield* Effect.promise(
        () => import('@shared/schemas'),
      );
      const { executeCliToolUseConfig } = yield* Effect.promise(loadExecuteCli);
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
        outcome: resolvedOutcome,
        outcomePersisted: true,
      });
      return yield* executeCliToolUseConfig(toolUseConfig(), cliContext(), {
        stopAfterCycle: true,
      });
    });

  // it.live for the two shutdown tests below: the run is forked in-fiber, but
  // runShutdown drives the lifecycle host's raw-setTimeout deadline and its
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
        const shutdown = platform.lifecycle.runShutdown();
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
        leaseOptions.onRun?.();
        mockCancelledOutcome();
        hangingRun.resolve(COMPLETED_RUN);

        yield* Deferred.await(noticeStarted);
        yield* settle;
        expect(mocks.writeTextStderrAndWait).toHaveBeenCalledOnce();
        let shutdownResolved = false;
        void shutdown.then(() => {
          shutdownResolved = true;
        });
        yield* settle;
        expect(shutdownResolved).toBe(false);
        settleRecoveryWrite();
        yield* Effect.promise(() => shutdown);
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
        const shutdown = platform.lifecycle.runShutdown();
        leaseOptions.onRunLeaseAcquired?.('exec-1' as RunId);
        leaseOptions.onRun?.();
        mockCancelledOutcome();
        hangingRun.resolve(COMPLETED_RUN);

        yield* Effect.promise(() => shutdown);
        yield* Fiber.join(run);
        expect(mocks.writeTextStderrAndWait).not.toHaveBeenCalled();
      }),
  );

  it.effect('reports invalid configs without starting the runtime host', () =>
    Effect.gen(function* () {
      const { executeCliConfig } = yield* Effect.promise(loadExecuteCli);
      const invalidConfig = {
        agentCategory: 'invalid',
      } as unknown as Parameters<typeof executeCliConfig>[0];

      const result = yield* executeCliConfig(invalidConfig, cliContext());

      expect(result).toMatchObject({ ok: false });
      expect(mocks.writeTextStderr).toHaveBeenCalledWith(expect.any(String));
      expect(mocks.createCliRuntimeHost).not.toHaveBeenCalled();
      expect(mocks.runAgent).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'derives the internal CLI result and exit code for tool-use configs',
    () =>
      Effect.gen(function* () {
        const result = yield* runCompletedToolUseConfig('completed');

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
          expect(Object.keys(result.result)).toEqual([
            'outcome',
            'output',
            'runId',
            'workingDirectory',
          ]);
        }
      }),
  );

  it.effect(
    'carries only the resolved outcome after a shutdown interruption',
    () =>
      Effect.gen(function* () {
        const result = yield* runCompletedToolUseConfig('cancelled');

        expect(result).toMatchObject({
          ok: true,
          exitCode: CliExitCode.Interrupted,
          result: {
            outcome: 'cancelled',
            workingDirectory: '/tmp/project',
          },
        });
        if (result.ok) {
          expect(Object.hasOwn(result.result, 'status')).toBe(false);
          expect(Object.hasOwn(result.result, 'terminalStatus')).toBe(false);
          expect(Object.hasOwn(result.result, 'endGroupStatus')).toBe(false);
        }
      }),
  );
});
