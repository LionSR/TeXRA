import '@test/support/sessionGraphTestSetup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import type { RunAgentOptions } from '@agent/runtime/runAgent';
import { RunHandle } from '@agent/runtime/RunHandle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { executeCliRequest } from '@cli/runtime/executeCli';
import { AgentError } from '@common/errors';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
} from '@shared/schemas';
import type { RunId, TodoItem } from '@shared/schemas';
import { createFakeHost, installFakeHost } from '@test/support/setupPlatform';
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

const tempDirs = useTempDirs();

async function installFreshDefaultSession(): Promise<void> {
  await installStoragePlatform();
  await import('@test/support/sessionGraphTestSetup');
  const { initializeDefaultSession, teardownDefaultSession } =
    await import('@agent/runtime/SessionHandle');
  teardownDefaultSession();
  initializeDefaultSession({});
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
  category: 'toolUse',
  runId: 'exec-1',
  outcome: 'completed',
} as const;

const COMPLETED_WORKFLOW_RUN: Parameters<
  NonNullable<RunAgentOptions['openWorkflowOutput']>
>[0] = {
  category: 'workflow',
  runId: 'exec-1' as RunId,
  outcome: 'completed',
  outputs: [],
  compileFailures: [],
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

async function loadExecuteCli() {
  const runtime = await import('@cli/runtime/executeCli');
  return {
    ...runtime,
    executeCliRequest: (
      ...args: Parameters<typeof runtime.executeCliRequest>
    ) => Effect.runPromise(runtime.executeCliRequest(...args)),
    executeCliConfig: (...args: Parameters<typeof runtime.executeCliConfig>) =>
      Effect.runPromise(runtime.executeCliConfig(...args)),
    executeCliToolUseConfig: (
      ...args: Parameters<typeof runtime.executeCliToolUseConfig>
    ) => Effect.runPromise(runtime.executeCliToolUseConfig(...args)),
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
 * Stubs runAgent to publish its lease options via `handleOptions` and then
 * hang until the test resolves it — the shape the shutdown-interrupt tests
 * drive.
 */
function stubHangingRun(handleOptions: (options: LeaseOptions) => void): {
  resolve: (result: unknown) => void;
} {
  let resolveRun!: (result: unknown) => void;
  mocks.runAgent.mockImplementation(async (request, options: LeaseOptions) => {
    handleOptions(options);
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
    flowRecord: { shared: {}, cursor: { nextNodeId: 'start' } },
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

/** Loads executeCliRequest against a fresh fake platform for shutdown tests. */
async function installFakePlatform() {
  const host = createFakeHost();
  await installFakeHost(host);
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

  it.each(['text', 'json'] as const)(
    'does not attach the CLI progress projection for %s output',
    async (outputFormat) => {
      const { executeCliRequest } = await loadExecuteCli();
      const { attachCliSessionProgressProjection } =
        await import('@cli/runtime/sessionProgressSubscription');
      const attachProjection = vi.mocked(attachCliSessionProgressProjection);
      const request = baseRequest();

      await executeCliRequest(request, cliContext({ outputFormat }));

      expect(attachProjection).not.toHaveBeenCalled();
      expect(mocks.detachSessionProgressProjection).not.toHaveBeenCalled();
    },
  );

  it('attaches the CLI progress projection for NDJSON output before the run starts', async () => {
    const { executeCliRequest } = await loadExecuteCli();
    const { attachCliSessionProgressProjection } =
      await import('@cli/runtime/sessionProgressSubscription');
    const attachProjection = vi.mocked(attachCliSessionProgressProjection);
    const request = baseRequest();

    await executeCliRequest(request, cliContext({ outputFormat: 'ndjson' }));

    expect(attachProjection).toHaveBeenCalledTimes(1);
    expect(attachProjection.mock.calls[0]?.[1]).toBeUndefined();
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    expect(attachProjection.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runAgent.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.detachSessionProgressProjection).toHaveBeenCalledTimes(1);
  });

  it('observes workflow-script children for every visible text run', async () => {
    const { executeCliRequest } = await loadExecuteCli();
    const request = {
      config: toolUseConfig(),
      runId: 'abcdef',
    } as CliRequest;

    await executeCliRequest(
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
      mocks.runAgent.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.attachRunProgressRenderer).toHaveBeenCalledTimes(1);
    expect(mocks.detachWorkflowPlainOutput).toHaveBeenCalledTimes(1);
  });

  it('keeps workflow-script progress quiet when run progress is disabled', async () => {
    const { executeCliRequest } = await loadExecuteCli();
    const request = {
      config: {
        agent: 'proof-workflow',
        model: 'gpt54',
        agentCategory: 'workflow',
      },
      runId: 'abcdef',
    } as CliRequest;

    await executeCliRequest(
      request,
      cliContext({ outputFormat: 'text', renderRunProgress: false }),
    );

    expect(mocks.attachWorkflowPlainOutput).not.toHaveBeenCalled();
  });

  it.each([
    { policy: 'never', overrides: {} },
    { policy: 'ask', overrides: { approvalPolicy: 'ask' } },
  ] as const)(
    'marks headless $policy runs as approval-unavailable for agent run',
    async ({ overrides }) => {
      const { executeCliRequest } = await loadExecuteCli();
      const request = baseRequest();

      await executeCliRequest(request, cliContext(overrides));

      expect(mocks.runAgent).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          approvalPromptsUnavailable: true,
        }),
      );
    },
  );

  it('keeps yolo runs approval-available for agent run', async () => {
    const { executeCliRequest } = await loadExecuteCli();
    const { defaultSession } = await import('@agent/runtime/SessionHandle');
    const request = baseRequest();

    await executeCliRequest(request, cliContext({ approvalPolicy: 'yolo' }));

    expect(defaultSession().approvalPolicy).toBe('yolo');
    expect(mocks.runAgent).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        approvalPromptsUnavailable: false,
      }),
    );
  });

  it('hides host-unavailable tools in CLI run', async () => {
    const { executeCliRequest } = await loadExecuteCli();
    const request = baseRequest();

    await executeCliRequest(
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
  });

  it('installs CLI host interactions with the runtime prompt hook', async () => {
    const { executeCliRequest } = await loadExecuteCli();
    const request = baseRequest();
    const context = cliContext({ mode: 'interactive', approvalPolicy: 'ask' });

    await executeCliRequest(request, context);

    expect(mocks.createHeadlessCliHostInteractions).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        beforePrompt: expect.any(Function),
        emit: expect.any(Function),
        setApprovalBypassState: expect.any(Function),
      }),
    );

    const hooks = mocks.createHeadlessCliHostInteractions.mock
      .calls[0]?.[1] as {
      beforePrompt?: () => void;
      emit?: (event: 'requestShowError', payload: { message: string }) => void;
      setApprovalBypassState?: (update: {
        runId: string;
        kind: 'bash';
        bypassActive: boolean;
      }) => void;
    };
    hooks.beforePrompt?.();
    expect(mocks.prepareInteractivePrompt).toHaveBeenCalledTimes(1);
    hooks.emit?.('requestShowError', { message: 'Run failed.' });
    expect(mocks.emit).toHaveBeenCalledWith('requestShowError', {
      message: 'Run failed.',
    });
    const update = {
      runId: 'stream:bypass',
      kind: 'bash',
      bypassActive: true,
    } as const;
    hooks.setApprovalBypassState?.(update);
    expect(
      mocks.createCliRuntimeHost.mock.results[0]?.value.emitApprovalBypassState,
    ).toHaveBeenCalledWith(update);
  });

  it('restores CLI host interactions before closing the runtime host', async () => {
    const { executeCliRequest } = await loadExecuteCli();
    const request = baseRequest();

    await executeCliRequest(request, cliContext());

    expect(mocks.disposeHostInteractions).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(
      mocks.disposeHostInteractions.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.close.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('reports outcome read failures without rejecting a successful run', async () => {
    const { executeCliRequest } = await loadExecuteCli();
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

    await expect(
      executeCliRequest(baseRequest(), cliContext()),
    ).resolves.toMatchObject({
      ok: true,
      result: { outcome: 'completed' },
    });
    expect(mocks.emit).toHaveBeenCalledWith('requestShowError', {
      message: 'metadata read failed',
    });
  });

  it('uses a persistent session and drains its artifacts after the run', async () => {
    const { executeCliRequest } = await loadExecuteCli();
    const request = baseRequest();
    const { store, flushSpy } = await spyOnArtifactFlush();
    const callOrder: string[] = [];
    flushSpy.mockImplementation(async () => {
      callOrder.push('flush');
    });
    mocks.runAgent.mockImplementationOnce(async () => {
      callOrder.push('runAgent');
      return {
        category: 'toolUse',
        runId: 'exec-1',
        status: 'completed',
      };
    });

    await executeCliRequest(request, cliContext());

    expect(store.mode).toEqual({ kind: 'persistent' });
    expect(callOrder).toEqual(['runAgent', 'flush']);
  });

  it('drains session artifacts even when the run throws', async () => {
    const { executeCliRequest } = await loadExecuteCli();
    const request = baseRequest();
    const { flushSpy } = await spyOnArtifactFlush();
    mocks.runAgent.mockRejectedValueOnce(new AgentError('boom'));

    // #7645: a classified run failure resolves to a non-zero exit code
    // instead of rethrowing — otherwise it reaches bin/texra.ts's crash
    // handler and gets misreported as an unexpected crash (double-printed
    // message + a false "please report it" line).
    const result = await executeCliRequest(request, cliContext());

    expect(result).toEqual({ ok: false, exitCode: CliExitCode.AgentError });
    expect(mocks.emit).toHaveBeenCalledWith('requestShowError', {
      message: 'boom',
    });
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-AgentError rejection instead of swallowing it into an exit code', async () => {
    const { executeCliRequest } = await loadExecuteCli();
    const request = baseRequest();
    const { flushSpy } = await spyOnArtifactFlush();
    // An unclassified failure (e.g. registerRun disk I/O,
    // workspaceState.update) is genuinely unexpected — it must keep
    // propagating so bin/texra.ts's crash handler reports it, instead of
    // being swallowed into a bare non-zero exit with no stderr.
    const runtime = await import('@agent/runtime');
    vi.spyOn(runtime, 'runAgent').mockReturnValueOnce(
      Effect.die(new Error('disk full')),
    );

    await expect(executeCliRequest(request, cliContext())).rejects.toThrow(
      'disk full',
    );

    // Cleanup still runs via `finally` even though the error propagates.
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('preserves a run failure when the final artifact flush also fails', async () => {
    const { executeCliRequest } = await loadExecuteCli();
    const { flushSpy } = await spyOnArtifactFlush();
    const runError = new Error('provider transport failed');
    const flushError = new Error('transcript flush failed');
    mocks.runAgent.mockRejectedValueOnce(runError);
    flushSpy.mockRejectedValueOnce(flushError);

    const rejection = executeCliRequest(baseRequest(), cliContext()).catch(
      (error: unknown) => error,
    );

    await expect(rejection).resolves.toEqual(
      expect.objectContaining({
        errors: [runError, flushError],
        message:
          'CLI run failed and its final artifacts could not be persisted',
      }),
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('resolves a classified run failure to a non-zero exit code without rethrowing or finalizing again', async () => {
    const { executeCliRequest } = await loadExecuteCli();
    const request = baseRequest();
    mocks.runAgent.mockImplementationOnce(
      async (_request: unknown, options: { readonly onRun?: () => void }) => {
        options.onRun?.();
        throw new AgentError('provider boom');
      },
    );

    const result = await executeCliRequest(request, cliContext());

    expect(result).toEqual({ ok: false, exitCode: CliExitCode.AgentError });
    expect(mocks.finalizeRun).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('does not repeat an error already presented before lifecycle startup', async () => {
    const { executeCliRequest } = await loadExecuteCli();
    mocks.runAgent.mockImplementationOnce(async () => {
      const hooks = mocks.createHeadlessCliHostInteractions.mock.calls[0]?.[1];
      hooks.emit('requestShowError', { message: 'Agent not found.' });
      throw new AgentError('Agent not found.');
    });

    await expect(
      executeCliRequest(baseRequest(), cliContext()),
    ).resolves.toEqual({ ok: false, exitCode: CliExitCode.AgentError });

    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('requestShowError', {
      message: 'Agent not found.',
    });
  });

  it('maps a completed run to Success even after a shared policy denial', async () => {
    const { executeCliRequest } = await loadExecuteCli();
    const { runOutcomeExitCode } = await import('@cli/runtime/terminalStatus');
    const request = baseRequest();
    const context = cliContext();
    mocks.runAgent.mockImplementationOnce(async (_request, options) => {
      options.onRunLeaseAcquired?.('exec-1' as RunId);
      options.onApprovalPolicyDenial?.();
      return COMPLETED_RUN;
    });

    await executeCliRequest(request, context);

    // A denied gate is feedback the model routes around, so it never affects
    // the exit code; reporting it as failure made callers discard good results.
    expect(runOutcomeExitCode('completed')).toBe(CliExitCode.Success);
    expect(runOutcomeExitCode('failed')).toBe(CliExitCode.AgentError);
  });

  it.each([
    { label: 'fresh', kind: 'fresh' },
    { label: 'resumed', kind: 'resume' },
  ] as const)(
    'marks $label owned runs interrupted during platform shutdown',
    async ({ kind }) => {
      const { platform, executeCliRequest } = await installFakePlatform();
      const { flushSpy } = await spyOnArtifactFlush();
      const { defaultSession } = await import('@agent/runtime/SessionHandle');
      const killSpy = vi.spyOn(defaultSession().runs, 'kill');
      mocks.releaseRunLeaseAfterArtifacts.mockImplementationOnce(
        async (session, runId) => session.flushArtifacts(runId),
      );
      let settleRecoveryWrite!: () => void;
      const recoveryWrite = new Promise<void>((resolve) => {
        settleRecoveryWrite = resolve;
      });
      const onInterruptedRunFinalized = vi.fn(() => recoveryWrite);
      let publishLeaseScope: LeaseOptions['onRunLeaseAcquired'];
      let publishRun: LeaseOptions['onRun'];
      const hangingRun = stubHangingRun((options) => {
        publishLeaseScope = options.onRunLeaseAcquired;
        publishRun = options.onRun;
      });

      const run = executeCliRequest(baseRequest(kind), cliContext(), {
        onInterruptedRunFinalized,
      });
      await vi.waitFor(() => expect(publishLeaseScope).toBeDefined());
      const shutdown = platform.lifecycle.runShutdown();
      await Promise.resolve();
      expect(mocks.finalizeRun).not.toHaveBeenCalled();
      publishLeaseScope?.('exec-1' as RunId);
      publishRun?.();
      await Promise.resolve();
      expect(killSpy).toHaveBeenCalledExactlyOnceWith('exec-1', {
        detachActiveChildren: false,
      });
      expect(mocks.releaseRunLeaseAfterArtifacts).not.toHaveBeenCalled();

      mockCancelledOutcome();
      hangingRun.resolve(COMPLETED_RUN);
      await vi.waitFor(() =>
        expect(onInterruptedRunFinalized).toHaveBeenCalledOnce(),
      );
      let shutdownResolved = false;
      void shutdown.then(() => {
        shutdownResolved = true;
      });
      await Promise.resolve();
      expect(shutdownResolved).toBe(false);
      settleRecoveryWrite();
      await shutdown;
      expect(mocks.releaseRunLeaseAfterArtifacts).toHaveBeenCalledOnce();
      expect(flushSpy).toHaveBeenCalled();
      expect(mocks.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'exec-1',
          outcome: RUN_OUTCOME.CANCELLED,
          flowRecord: 'preserve',
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
      await expect(run).resolves.toEqual({
        ok: true,
        outcomePersisted: true,
        result: {
          category: 'toolUse',
          runId: 'exec-1',
          outcome: 'cancelled',
        },
      });
      expect(mocks.finalizeRun).toHaveBeenCalledOnce();
    },
  );

  it('does not advertise signal recovery before a flow checkpoint exists', async () => {
    const { platform, executeCliRequest } = await installFakePlatform();
    mocks.deriveResumability.mockResolvedValueOnce({
      kind: 'none',
      outcome: RUN_OUTCOME.CANCELLED,
    });
    const onInterruptedRunFinalized = vi.fn();
    let publishLeaseScope: LeaseOptions['onRunLeaseAcquired'];
    let publishRun: LeaseOptions['onRun'];
    const hangingRun = stubHangingRun((options) => {
      publishLeaseScope = options.onRunLeaseAcquired;
      publishRun = options.onRun;
    });

    const run = executeCliRequest(baseRequest(), cliContext(), {
      onInterruptedRunFinalized,
    });
    await vi.waitFor(() => expect(publishLeaseScope).toBeDefined());
    const shutdown = platform.lifecycle.runShutdown();
    publishLeaseScope?.('exec-1' as RunId);
    publishRun?.();
    mockCancelledOutcome();
    hangingRun.resolve(COMPLETED_RUN);

    await shutdown;
    await run;

    expect(mocks.deriveResumability).toHaveBeenCalledExactlyOnceWith(
      'exec-1',
      expect.anything(),
    );
    expect(onInterruptedRunFinalized).not.toHaveBeenCalled();
  });

  // The pre-checkpoint shutdown bound is the lifecycle host's per-phase
  // join-with-deadline; its regression pin lives in LifecycleHost.vitest.ts.

  it('forwards a failed shutdown drain to the runtime release hook', async () => {
    const { platform, executeCliRequest } = await installFakePlatform();
    const drainError = new Error('snapshot drain failed');
    mocks.releaseRunLeaseAfterArtifacts.mockRejectedValueOnce(drainError);
    let leaseOptions: LeaseOptions | undefined;
    const hangingRun = stubHangingRun((options) => {
      leaseOptions = options;
    });

    const run = executeCliRequest(baseRequest(), cliContext(), {});
    await vi.waitFor(() => expect(leaseOptions).toBeDefined());
    leaseOptions?.onRunLeaseAcquired?.('exec-1' as RunId);
    const shutdown = platform.lifecycle.runShutdown();

    await expect(leaseOptions?.beforeLeaseRelease?.()).rejects.toBe(drainError);
    hangingRun.resolve(COMPLETED_RUN);
    await shutdown;
    await run;
  });

  it('cancels launch preparation when shutdown precedes run registration', async () => {
    const { platform, executeCliRequest } = await installFakePlatform();
    let launchSignal: AbortSignal | undefined;
    mocks.runAgent.mockImplementationOnce(
      async (_request: unknown, options: LeaseOptions) => {
        launchSignal = options.launchSignal;
        await new Promise<void>((_resolve, reject) => {
          options.launchSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('Launch interrupted.', 'AbortError')),
            { once: true },
          );
        });
        return COMPLETED_RUN;
      },
    );

    const run = executeCliRequest(baseRequest(), cliContext(), {});
    await vi.waitFor(() => expect(launchSignal).toBeDefined());

    await platform.lifecycle.runShutdown();
    await expect(run).resolves.toEqual({
      ok: false,
      exitCode: CliExitCode.Interrupted,
    });
    expect(launchSignal?.aborted).toBe(true);
    expect(mocks.finalizeRun).not.toHaveBeenCalled();
  });

  it('preserves a terminal outcome when shutdown cannot interrupt the finished run', async () => {
    const { platform, executeCliRequest } = await installFakePlatform();
    const { defaultSession } = await import('@agent/runtime/SessionHandle');
    vi.spyOn(defaultSession().runs, 'kill').mockReturnValue({
      accepted: false,
      settlement: Effect.void,
    });
    let leaseOptions: LeaseOptions | undefined;
    const hangingRun = stubHangingRun((options) => {
      leaseOptions = options;
    });
    const run = executeCliRequest(baseRequest(), cliContext(), {});
    await vi.waitFor(() => expect(leaseOptions).toBeDefined());
    leaseOptions?.onRunLeaseAcquired?.('exec-1' as RunId);
    leaseOptions?.onRun?.();

    const shutdown = platform.lifecycle.runShutdown();
    hangingRun.resolve(COMPLETED_RUN);
    await shutdown;
    await run;

    expect(mocks.finalizeRun).not.toHaveBeenCalled();
    expect(mocks.releaseRunLeaseAfterArtifacts).not.toHaveBeenCalled();
  });

  it('denies workflow output publication after shutdown interruption commits', async () => {
    const { platform, executeCliRequest } = await installFakePlatform();
    let leaseOptions: LeaseOptions | undefined;
    const hangingRun = stubHangingRun((options) => {
      leaseOptions = options;
    });
    let publicationCommitted: boolean | undefined;
    const run = executeCliRequest(baseRequest(), cliContext(), {
      openWorkflowOutput: (_result, tryCommitPublication) =>
        Effect.sync(() => {
          publicationCommitted = tryCommitPublication();
        }),
    });
    await vi.waitFor(() => expect(leaseOptions).toBeDefined());

    const shutdown = platform.lifecycle.runShutdown();
    leaseOptions?.onRunLeaseAcquired?.('exec-1' as RunId);
    leaseOptions?.onRun?.();
    await leaseOptions?.openWorkflowOutput?.(COMPLETED_WORKFLOW_RUN);
    mockCancelledOutcome();
    hangingRun.resolve(COMPLETED_WORKFLOW_RUN);

    await shutdown;
    await expect(run).resolves.toMatchObject({
      ok: true,
      result: { outcome: RUN_OUTCOME.CANCELLED },
    });
    expect(publicationCommitted).toBe(false);
    expect(mocks.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'exec-1',
        outcome: RUN_OUTCOME.CANCELLED,
        flowRecord: 'preserve',
      }),
    );
  });

  it('preserves the workflow verdict after output publication commits', async () => {
    const { platform, executeCliRequest } = await installFakePlatform();
    const { defaultSession } = await import('@agent/runtime/SessionHandle');
    const killSpy = vi.spyOn(defaultSession().runs, 'kill');
    let leaseOptions: LeaseOptions | undefined;
    const hangingRun = stubHangingRun((options) => {
      leaseOptions = options;
    });
    let publicationCommitted: boolean | undefined;
    const run = executeCliRequest(baseRequest(), cliContext(), {
      openWorkflowOutput: (_result, tryCommitPublication) =>
        Effect.sync(() => {
          publicationCommitted = tryCommitPublication();
        }),
    });
    await vi.waitFor(() => expect(leaseOptions).toBeDefined());
    leaseOptions?.onRunLeaseAcquired?.('exec-1' as RunId);
    leaseOptions?.onRun?.();
    await leaseOptions?.openWorkflowOutput?.(COMPLETED_WORKFLOW_RUN);

    const shutdown = platform.lifecycle.runShutdown();
    hangingRun.resolve(COMPLETED_WORKFLOW_RUN);

    await shutdown;
    await expect(run).resolves.toMatchObject({
      ok: true,
      result: { outcome: RUN_OUTCOME.COMPLETED },
    });
    expect(publicationCommitted).toBe(true);
    expect(killSpy).not.toHaveBeenCalled();
    expect(mocks.finalizeRun).not.toHaveBeenCalled();
  });

  it('does not convert a committed output failure to cancelled by a later shutdown', async () => {
    const { platform, executeCliRequest } = await installFakePlatform();
    const { defaultSession } = await import('@agent/runtime/SessionHandle');
    // Imported dynamically (like the lease test below) so the `instanceof`
    // check in executeCli.ts sees the same module instance even after an
    // earlier test's `vi.resetModules()` in this file.
    const { AgentError: RuntimeAgentError } = await import('@common/errors');
    const killSpy = vi.spyOn(defaultSession().runs, 'kill');
    const outputFailure = new Error(
      'Workflow completed without generated outputs; nothing was copied to out.',
    );
    let publicationCommitted: boolean | undefined;
    let outputResolutionFailed = false;
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

    const run = executeCliRequest(baseRequest(), cliContext(), {
      openWorkflowOutput: (_result, tryCommitPublication) =>
        Effect.sync(() => {
          publicationCommitted = tryCommitPublication();
        }).pipe(Effect.andThen(Effect.fail(outputFailure))),
    });

    await vi.waitFor(() => expect(outputResolutionFailed).toBe(true));
    const shutdown = platform.lifecycle.runShutdown();
    await Promise.resolve();
    expect(killSpy).not.toHaveBeenCalled();

    releaseRun();
    await shutdown;
    await expect(run).resolves.toEqual({
      ok: false,
      exitCode: CliExitCode.AgentError,
    });
    expect(publicationCommitted).toBe(true);
    expect(mocks.finalizeRun).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('requestShowError', {
      message: `Error executing agent polish: ${outputFailure.message}`,
    });
  });

  it('does not report a shutdown drain that fails because the lease is already lost', async () => {
    const { platform, executeCliRequest } = await installFakePlatform();
    // Imported dynamically (matching the module above) so the `instanceof`
    // check in executeCli.ts sees the same module instance even after an
    // earlier test's `vi.resetModules()` in this file.
    const { RunLeaseLostError } = await import('@agent/storage');
    mocks.releaseRunLeaseAfterArtifacts.mockRejectedValueOnce(
      new RunLeaseLostError('exec-1' as RunId),
    );
    let leaseOptions: LeaseOptions | undefined;
    const hangingRun = stubHangingRun((options) => {
      leaseOptions = options;
    });

    const run = executeCliRequest(baseRequest(), cliContext(), {});
    await vi.waitFor(() => expect(leaseOptions).toBeDefined());
    leaseOptions?.onRunLeaseAcquired?.('exec-1' as RunId);
    const shutdown = platform.lifecycle.runShutdown();

    await expect(leaseOptions?.beforeLeaseRelease?.()).resolves.toBe(false);
    hangingRun.resolve(COMPLETED_RUN);
    await shutdown;
    await run;
  });

  it('closes the runtime host when shutdown finalization fails', async () => {
    const { platform, executeCliRequest } = await installFakePlatform();
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
    const hangingRun = stubHangingRun((options) => {
      options.onRunLeaseAcquired?.('exec-1' as RunId);
    });

    const onInterruptedRunFinalized = vi.fn();
    const run = executeCliRequest(baseRequest(), cliContext(), {
      onInterruptedRunFinalized,
    });
    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledOnce());
    const shutdown = platform.lifecycle.runShutdown();
    await Promise.resolve();
    expect(mocks.emit).not.toHaveBeenCalled();
    mockCancelledOutcome();
    hangingRun.resolve(COMPLETED_RUN);
    await shutdown;
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('requestShowError', {
      message:
        'Failed to persist cancelled terminal state for run exec-1: terminal metadata disk full',
    });

    await expect(run).resolves.toEqual({
      ok: true,
      outcomePersisted: true,
      result: {
        category: 'toolUse',
        runId: 'exec-1',
        outcome: 'cancelled',
      },
    });
    expect(mocks.finalizeRun).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(onInterruptedRunFinalized).not.toHaveBeenCalled();
  });

  it('removes the shutdown status hook after owned runs finish', async () => {
    const { platform, executeCliRequest } = await installFakePlatform();
    const request = baseRequest();

    await executeCliRequest(request, cliContext(), {});
    mocks.finalizeRun.mockClear();
    await platform.lifecycle.runShutdown();

    expect(mocks.finalizeRun).not.toHaveBeenCalled();
  });
});

describe('executeCliConfig', () => {
  beforeEach(async () => {
    await stubExecuteCliDeps();
    await installFreshDefaultSession();
  });

  /** Stubs a completed tool-use run and drives executeCliToolUseConfig. */
  async function runCompletedToolUseConfig(resolvedOutcome: string) {
    const { AgentCategory } = await import('@shared/schemas');
    const { executeCliToolUseConfig } = await loadExecuteCli();
    mocks.runAgent.mockResolvedValueOnce({
      category: AgentCategory.ToolUse,
      runId: 'exec-1',
      outcome: 'completed',
      response: 'Done.',
    });
    mocks.readCliRunOutcomeState.mockResolvedValueOnce({
      outcome: resolvedOutcome,
      outcomePersisted: true,
    });
    return executeCliToolUseConfig(toolUseConfig(), cliContext(), {
      stopAfterCycle: true,
    });
  }

  it('prints a complete resume command after interrupted tool-use recovery is available', async () => {
    const { platform } = await installFakePlatform();
    const { executeCliToolUseConfig } = await loadExecuteCli();
    const context = cliContext({
      approvalPolicy: 'yolo',
      outputFormat: 'ndjson',
      skillSourceOptions: {
        includeInterop: true,
        additionalPaths: ['/tmp/skill path'],
      },
    });
    let publishLeaseScope: LeaseOptions['onRunLeaseAcquired'];
    let publishRun: LeaseOptions['onRun'];
    const hangingRun = stubHangingRun((options) => {
      publishLeaseScope = options.onRunLeaseAcquired;
      publishRun = options.onRun;
    });
    let settleRecoveryWrite!: () => void;
    const recoveryWrite = new Promise<void>((resolve) => {
      settleRecoveryWrite = resolve;
    });
    mocks.writeTextStderrAndWait.mockReturnValueOnce(recoveryWrite);

    const run = executeCliToolUseConfig(toolUseConfig(), context, {
      stopAfterCycle: true,
    });
    await vi.waitFor(() => expect(publishLeaseScope).toBeDefined());
    const shutdown = platform.lifecycle.runShutdown();
    publishLeaseScope?.('exec-1' as RunId);
    publishRun?.();
    mockCancelledOutcome();
    hangingRun.resolve(COMPLETED_RUN);

    await vi.waitFor(() =>
      expect(mocks.writeTextStderrAndWait).toHaveBeenCalledOnce(),
    );
    let shutdownResolved = false;
    void shutdown.then(() => {
      shutdownResolved = true;
    });
    await Promise.resolve();
    expect(shutdownResolved).toBe(false);
    settleRecoveryWrite();
    await shutdown;
    await expect(run).resolves.toMatchObject({
      ok: true,
      exitCode: CliExitCode.Interrupted,
    });
    expect(mocks.writeTextStderrAndWait).toHaveBeenCalledExactlyOnceWith(
      "Resume this session with: texra resume exec-1 --cwd /tmp/project --approval-policy yolo --include-interop --source '/tmp/skill path'",
    );
  });

  it('does not advertise recovery for invocation-owned temporary inputs', async () => {
    const { platform } = await installFakePlatform();
    const { executeCliToolUseConfig } = await loadExecuteCli();
    let publishLeaseScope: LeaseOptions['onRunLeaseAcquired'];
    let publishRun: LeaseOptions['onRun'];
    const hangingRun = stubHangingRun((options) => {
      publishLeaseScope = options.onRunLeaseAcquired;
      publishRun = options.onRun;
    });

    const run = executeCliToolUseConfig(toolUseConfig(), cliContext(), {
      recoveryInputIsDurable: false,
    });
    await vi.waitFor(() => expect(publishLeaseScope).toBeDefined());
    const shutdown = platform.lifecycle.runShutdown();
    publishLeaseScope?.('exec-1' as RunId);
    publishRun?.();
    mockCancelledOutcome();
    hangingRun.resolve(COMPLETED_RUN);

    await shutdown;
    await run;
    expect(mocks.writeTextStderrAndWait).not.toHaveBeenCalled();
  });

  it('reports invalid configs without starting the runtime host', async () => {
    const { executeCliConfig } = await loadExecuteCli();
    const invalidConfig = { agentCategory: 'invalid' } as unknown as Parameters<
      typeof executeCliConfig
    >[0];

    const result = await executeCliConfig(invalidConfig, cliContext());

    expect(result).toMatchObject({ ok: false });
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(expect.any(String));
    expect(mocks.createCliRuntimeHost).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it('derives the internal CLI result and exit code for tool-use configs', async () => {
    const result = await runCompletedToolUseConfig('completed');

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      result: {
        outcome: 'completed',
        workingDirectory: '/tmp/project',
        response: 'Done.',
      },
    });
    if (result.ok) {
      expect(Object.keys(result.result)).toEqual([
        'category',
        'runId',
        'outcome',
        'response',
        'workingDirectory',
      ]);
    }
  });

  it('carries only the resolved outcome after a shutdown interruption', async () => {
    const result = await runCompletedToolUseConfig('cancelled');

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
  });
});
