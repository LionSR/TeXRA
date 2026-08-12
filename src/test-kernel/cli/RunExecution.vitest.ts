import { mkdtemp } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliExitCode } from '@cli/runtime/exitCodes';
import type { executeCliRequest } from '@cli/runtime/runExecution';
import { AgentError } from '@common/errors';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StorageKey,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { createFakePlatform } from '@test/support/FakePlatform';
import { createTestCliContext as cliContext } from '@test/cli/fixtures/cliContext';
import { cleanupTempDirs } from '@test/support/tempDirPlatform';
import { DIAGNOSTICS_READ_RUNTIME_CAPABILITY } from '@tools/diagnosticsRuntimeCapabilities';
import { SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES } from '@tools/setup/platform';

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
  readCliRunOutcome: vi.fn(),
  releaseExecutionLeaseAfterArtifacts: vi.fn(),
  runAgent: vi.fn(),
  writeTextStderr: vi.fn(),
  finalizeExecution: vi.fn(),
}));

const tempDirs: string[] = [];

async function installFreshDefaultSession(): Promise<void> {
  const { installPlatform } = await import('@test/support/setupPlatform');
  await installPlatform();
  const [
    { initializeDefaultSession, teardownDefaultSession },
    { StreamLogStore },
  ] = await Promise.all([
    import('@agent/runtime/SessionHandle'),
    import('@transcript'),
  ]);
  teardownDefaultSession();
  initializeDefaultSession({ transcripts: await StreamLogStore.open() });
}

async function installStoragePlatform(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'texra-run-'));
  tempDirs.push(tempDir);
  const workspaceDir = path.join(tempDir, 'workspace');
  const storageRoot = path.join(tempDir, 'storage');
  const { initPlatform } = await import('@platform/platform');
  initPlatform(
    createFakePlatform(
      { workspacePath: workspaceDir },
      {
        fs: nodeFilesystem,
        workspace: createNodeWorkspace(() => workspaceDir),
        storage: new WorkspaceStorageProvider(storageRoot, workspaceDir),
        globalState: new MemoryStateStore(),
        workspaceState: new MemoryStateStore(),
      },
    ),
  );
}

vi.mock('@agent/runtime/runAgent', () => ({
  runAgent: mocks.runAgent,
}));

vi.mock('@cli/runtime/executionFinalization', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@cli/runtime/executionFinalization')
  >()),
  releaseCliExecutionLeaseAfterArtifacts:
    mocks.releaseExecutionLeaseAfterArtifacts,
}));

vi.mock('@agent/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage')>()),
  finalizeExecution: mocks.finalizeExecution,
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
  readCliRunOutcome: mocks.readCliRunOutcome,
}));

vi.mock('@cli/runtime/sessionProgressSubscription', () => ({
  attachCliSessionProgressProjection: vi.fn(
    () => mocks.detachSessionProgressProjection,
  ),
}));

vi.mock('@cli/runtime/workflowPlainOutput', () => ({
  attachWorkflowPlainOutput: mocks.attachWorkflowPlainOutput,
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStderr: mocks.writeTextStderr,
}));

type CliRequest = Parameters<typeof executeCliRequest>[0];

/** Result shape the default `runAgent` stub resolves with. */
const COMPLETED_RUN = {
  category: 'toolUse',
  executionId: 'exec-1',
  outcome: 'completed',
  streamId: 'stream-1',
} as const;

function baseRequest(): CliRequest {
  return { config: {}, executionId: 'exec-1' } as CliRequest;
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

function loadRunExecution(): Promise<
  typeof import('@cli/runtime/runExecution')
> {
  return import('@cli/runtime/runExecution');
}

type LeaseOptions = {
  beforeLeaseRelease?: () => Promise<boolean | void>;
  onRun?: () => void;
  onExecutionLeaseAcquired?: (
    scope: (operation: () => unknown) => unknown,
    executionId: ExecutionId,
  ) => void;
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
  mocks.runAgent.mockImplementation(async (_request, options: LeaseOptions) => {
    handleOptions(options);
    return new Promise((resolve) => {
      resolveRun = resolve;
    });
  });
  return { resolve: (result: unknown) => resolveRun(result) };
}

/** Spies on the default session's transcript store flush. */
async function spyOnTranscriptFlush() {
  const { defaultSession } = await import('@agent/runtime/SessionHandle');
  const store = defaultSession().transcripts;
  const flushSpy = vi.spyOn(store, 'flush').mockResolvedValue(undefined);
  return { store, flushSpy };
}

function stubRunExecutionDeps(): void {
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
  mocks.readCliRunOutcome.mockResolvedValue('completed');
  mocks.releaseExecutionLeaseAfterArtifacts.mockResolvedValue(undefined);
  mocks.finalizeExecution.mockResolvedValue({
    status: 'durable',
    outcomePersisted: true,
    flowRecord: 'deleted',
  });
  mocks.runAgent.mockImplementation(async (_request, options) => {
    options.onExecutionLeaseAcquired?.(
      (operation: () => unknown) => operation(),
      'exec-1' as ExecutionId,
    );
    return COMPLETED_RUN;
  });
}

/** Loads executeCliRequest against a fresh fake platform for shutdown tests. */
async function installFakePlatform() {
  const { initPlatform } = await import('@platform/platform');
  const platform = createFakePlatform();
  initPlatform(platform);
  const { executeCliRequest } = await loadRunExecution();
  return { platform, executeCliRequest };
}

describe('executeCliRequest', () => {
  beforeEach(async () => {
    stubRunExecutionDeps();
    await installFreshDefaultSession();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDirs(tempDirs);
  });

  it.each(['text', 'json'] as const)(
    'does not attach the CLI progress projection for %s output',
    async (outputFormat) => {
      const { executeCliRequest } = await loadRunExecution();
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
    const { executeCliRequest } = await loadRunExecution();
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
    const { executeCliRequest } = await loadRunExecution();
    const request = {
      config: toolUseConfig(),
      executionId: 'abcdef',
    } as CliRequest;

    await executeCliRequest(
      request,
      cliContext({ outputFormat: 'text', renderRunProgress: true }),
    );

    expect(mocks.attachWorkflowPlainOutput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
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
    const { executeCliRequest } = await loadRunExecution();
    const request = {
      config: {
        agent: 'proof-workflow',
        model: 'gpt54',
        agentCategory: 'workflow',
      },
      executionId: 'abcdef',
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
    'marks headless $policy runs as approval-unavailable for agent execution',
    async ({ overrides }) => {
      const { executeCliRequest } = await loadRunExecution();
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

  it('keeps yolo runs approval-available for agent execution', async () => {
    const { executeCliRequest } = await loadRunExecution();
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

  it('hides host-unavailable tools in CLI execution', async () => {
    const { executeCliRequest } = await loadRunExecution();
    const request = baseRequest();

    await executeCliRequest(
      request,
      cliContext({ mode: 'interactive', approvalPolicy: 'ask' }),
    );

    expect(mocks.runAgent).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        approvalPromptsUnavailable: false,
        runtimeUnavailableTools: [
          'inquiry',
          ...SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES,
          'inline_comment',
          DIAGNOSTICS_READ_RUNTIME_CAPABILITY,
        ],
      }),
    );
  });

  it('preserves caller-provided runtime tool exclusions', async () => {
    const { executeCliRequest } = await loadRunExecution();
    const request = baseRequest();

    await executeCliRequest(request, cliContext(), {
      runtimeUnavailableTools: ['custom_tool'],
    });

    expect(mocks.runAgent).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        runtimeUnavailableTools: [
          'inquiry',
          ...SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES,
          'inline_comment',
          DIAGNOSTICS_READ_RUNTIME_CAPABILITY,
          'custom_tool',
        ],
      }),
    );
  });

  it('installs CLI host interactions with the runtime prompt hook', async () => {
    const { executeCliRequest } = await loadRunExecution();
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
        streamId: string;
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
      streamId: 'stream:bypass',
      kind: 'bash',
      bypassActive: true,
    } as const;
    hooks.setApprovalBypassState?.(update);
    expect(
      mocks.createCliRuntimeHost.mock.results[0]?.value.emitApprovalBypassState,
    ).toHaveBeenCalledWith(update);
  });

  it('restores CLI host interactions before closing the runtime host', async () => {
    const { executeCliRequest } = await loadRunExecution();
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
    const { executeCliRequest } = await loadRunExecution();
    const readError = new Error('metadata read failed');
    mocks.readCliRunOutcome.mockImplementationOnce(
      async (
        result: { readonly outcome: string },
        reportReadFailure: (error: Error) => void,
      ) => {
        reportReadFailure(readError);
        return result.outcome;
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

  it('persists headless stream sidecars from session events', async () => {
    await installStoragePlatform();
    const { executeCliRequest } = await loadRunExecution();
    const request = baseRequest();
    const streamId = 'stream-1' as StreamTabId;
    const parentStreamId = 'parent-stream' as StreamTabId;
    const executionId = 'b1c2d3e4' as ExecutionId;
    const todo: TodoItem = {
      content: 'Write the introduction',
      status: 'in_progress',
      activeForm: 'Writing the introduction',
    };

    mocks.runAgent.mockImplementationOnce(async () => {
      const { getExecutionStore } = await import('@agent/storage');
      const { AgentConfigSchema } =
        await import('@agent/core/definition/AgentConfig');
      const { defaultSession } = await import('@agent/runtime/SessionHandle');
      const config = AgentConfigSchema.parse(toolUseConfig());

      await getExecutionStore(executionId).writeRunRecord(config);
      // Emitter contract (#9590 A4/Stage 6): the authority write to
      // `ExecutionMeta.description` lands before the display event below.
      await getExecutionStore(executionId).writeMeta({
        timestamp: new Date(0).toISOString(),
        description: 'chat / gpt54',
      });
      defaultSession().events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'run.config',
          streamId,
          executionId,
          config,
        },
      });
      defaultSession().events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'updateTodos',
          streamId,
          todos: [todo],
        },
      });
      defaultSession().events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'usage',
          payload: {
            streamId,
            storageKey: 'run-1' as StorageKey,
            usage: { inputTokens: 100, outputTokens: 20, cost: 0.5 },
          },
        },
      });
      defaultSession().events.emit({
        scope: 'session',
        event: {
          type: 'updateStreamDescription',
          payload: {
            streamId,
            description: 'chat / gpt54',
          },
        },
      });
      defaultSession().events.emit({
        scope: 'session',
        event: {
          type: 'setParentStream',
          payload: {
            childStreamId: streamId,
            parentStreamId,
          },
        },
      });
      return {
        category: 'toolUse',
        executionId: 'exec-1',
        status: 'completed',
        streamId,
      };
    });

    await executeCliRequest(request, cliContext());

    const { StreamSnapshotStore } = await import('@transcript');
    const reader = new StreamSnapshotStore();
    await reader.load([streamId]);
    const snapshot = await reader.read(streamId);
    expect(snapshot.todos).toEqual([todo]);
    expect(snapshot.runUsage['run-1']).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cost: 0.5,
    });
    expect(snapshot.executionId).toBe(executionId);
    // Current records read the description via ExecutionMeta (#9590 Stage 6);
    // the snapshot field is the legacy sidecar mirror and stays unwritten.
    expect(reader.getRunMetadata(streamId).description).toBe('chat / gpt54');
    expect(snapshot.description).toBeUndefined();
    const { getExecutionStore } = await import('@agent/storage');
    expect((await getExecutionStore(executionId).readMeta())?.description).toBe(
      'chat / gpt54',
    );
    expect(snapshot.parentStreamId).toBe(parentStreamId);
    expect(reader.getRunMetadata(streamId).config).toMatchObject({
      agent: 'chat',
      model: 'gpt54',
      agentCategory: 'toolUse',
    });
  });

  it('uses an opened persistent store and flushes it after the run', async () => {
    const { executeCliRequest } = await loadRunExecution();
    const request = baseRequest();
    const { store, flushSpy } = await spyOnTranscriptFlush();
    const callOrder: string[] = [];
    flushSpy.mockImplementation(async () => {
      callOrder.push('flush');
    });
    mocks.runAgent.mockImplementationOnce(async () => {
      callOrder.push('runAgent');
      return {
        category: 'toolUse',
        executionId: 'exec-1',
        status: 'completed',
        streamId: 'stream-1',
      };
    });

    await executeCliRequest(request, cliContext());

    expect(store.mode).toEqual({ kind: 'persistent' });
    expect(callOrder).toEqual(['runAgent', 'flush']);
  });

  it('flushes the stream log store even when the run throws', async () => {
    const { executeCliRequest } = await loadRunExecution();
    const request = baseRequest();
    const { flushSpy } = await spyOnTranscriptFlush();
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
    const { executeCliRequest } = await loadRunExecution();
    const request = baseRequest();
    const { flushSpy } = await spyOnTranscriptFlush();
    // An unclassified failure (e.g. registerExecution disk I/O,
    // workspaceState.update) is genuinely unexpected — it must keep
    // propagating so bin/texra.ts's crash handler reports it, instead of
    // being swallowed into a bare non-zero exit with no stderr.
    mocks.runAgent.mockRejectedValueOnce(new Error('disk full'));

    await expect(executeCliRequest(request, cliContext())).rejects.toThrow(
      'disk full',
    );

    // Cleanup still runs via `finally` even though the error propagates.
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed run terminal status when wrap cleanup fails after invoke succeeded (#7863)', async () => {
    const { executeCliRequest } = await loadRunExecution();
    const request = baseRequest();
    // runAgent resolves (default mock): the lifecycle has already persisted
    // the run's true terminal status. A rejection from wrap's post-run
    // cleanup must still propagate to the crash handler, but must NOT
    // overwrite that status with ERROR.
    const cleanupError = new Error('workspaceState.update failed');

    await expect(
      executeCliRequest(request, cliContext(), {
        wrap: async (run) => {
          await run();
          throw cleanupError;
        },
      }),
    ).rejects.toBe(cleanupError);

    expect(mocks.finalizeExecution).not.toHaveBeenCalledWith({
      executionId: 'exec-1',
      outcome: RUN_OUTCOME.FAILED,
      flowRecord: 'delete',
    });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('resolves a classified run failure to a non-zero exit code without rethrowing or finalizing again', async () => {
    const { executeCliRequest } = await loadRunExecution();
    const request = baseRequest();
    mocks.runAgent.mockImplementationOnce(
      async (_request: unknown, options: { readonly onRun?: () => void }) => {
        options.onRun?.();
        throw new AgentError('provider boom');
      },
    );

    const result = await executeCliRequest(request, cliContext());

    expect(result).toEqual({ ok: false, exitCode: CliExitCode.AgentError });
    expect(mocks.finalizeExecution).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('does not repeat an error already presented before lifecycle startup', async () => {
    const { executeCliRequest } = await loadRunExecution();
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
    const { executeCliRequest } = await loadRunExecution();
    const { runOutcomeExitCode } = await import('@cli/runtime/terminalStatus');
    const request = baseRequest();
    const context = cliContext();
    mocks.runAgent.mockImplementationOnce(async (_request, options) => {
      options.onExecutionLeaseAcquired?.(
        (operation: () => unknown) => operation(),
        'exec-1' as ExecutionId,
      );
      options.onApprovalPolicyDenial?.();
      return COMPLETED_RUN;
    });

    await executeCliRequest(request, context);

    // A denied gate is feedback the model routes around, so it never affects
    // the exit code; reporting it as failure made callers discard good results.
    expect(runOutcomeExitCode('completed')).toBe(CliExitCode.Success);
    expect(runOutcomeExitCode('failed')).toBe(CliExitCode.AgentError);
  });

  it('closes the runtime host when sidecar flush fails', async () => {
    vi.resetModules();
    const flushError = new Error('flush failed');
    // The session owns the sidecar store, so the stub has to replace the
    // module `SessionHandle` imports (not the `@transcript` barrel).
    vi.doMock('@transcript/StreamSnapshotStore', () => ({
      StreamSnapshotStore: class {
        attachSessionEvents = vi.fn(() => vi.fn());

        handleProgressEvent = vi.fn();

        load = vi.fn(async () => undefined);

        getExecutionIdMap = vi.fn(() => new Map());

        flush = vi.fn(async () => {
          throw flushError;
        });
      },
    }));

    try {
      await installFreshDefaultSession();
      const { executeCliRequest } = await loadRunExecution();
      const request = baseRequest();

      await expect(executeCliRequest(request, cliContext())).rejects.toThrow(
        flushError,
      );

      expect(mocks.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('@transcript/StreamSnapshotStore');
      vi.resetModules();
      await installFreshDefaultSession();
    }
  });

  it.each([
    { label: 'fresh', options: { registerExecution: true } },
    { label: 'resumed', options: {} },
  ] as const)(
    'marks $label owned executions interrupted during platform shutdown',
    async ({ options }) => {
      const { platform, executeCliRequest } = await installFakePlatform();
      const { flushSpy } = await spyOnTranscriptFlush();
      const { defaultSession } = await import('@agent/runtime/SessionHandle');
      const killSpy = vi.spyOn(defaultSession().executions, 'kill');
      mocks.releaseExecutionLeaseAfterArtifacts.mockImplementationOnce(
        async (session, executionId) => session.flushArtifacts(executionId),
      );
      const runWithOwnership = vi.fn((operation: () => unknown) => operation());
      let publishLeaseScope: LeaseOptions['onExecutionLeaseAcquired'];
      let publishRun: LeaseOptions['onRun'];
      const hangingRun = stubHangingRun((options) => {
        publishLeaseScope = options.onExecutionLeaseAcquired;
        publishRun = options.onRun;
      });

      const run = executeCliRequest(baseRequest(), cliContext(), options);
      await vi.waitFor(() => expect(publishLeaseScope).toBeDefined());
      const shutdown = platform.lifecycle.runShutdown();
      await Promise.resolve();
      expect(mocks.finalizeExecution).not.toHaveBeenCalled();
      publishLeaseScope?.(runWithOwnership, 'exec-1' as ExecutionId);
      publishRun?.();
      await Promise.resolve();
      expect(killSpy).toHaveBeenCalledExactlyOnceWith('exec-1');
      expect(mocks.releaseExecutionLeaseAfterArtifacts).not.toHaveBeenCalled();

      mocks.readCliRunOutcome.mockResolvedValueOnce('cancelled');
      hangingRun.resolve(COMPLETED_RUN);
      await shutdown;
      expect(runWithOwnership).toHaveBeenCalledOnce();
      expect(mocks.releaseExecutionLeaseAfterArtifacts).toHaveBeenCalledOnce();
      expect(flushSpy).toHaveBeenCalled();
      expect(mocks.finalizeExecution).toHaveBeenCalledWith({
        executionId: 'exec-1',
        outcome: RUN_OUTCOME.CANCELLED,
        flowRecord: 'preserve',
      });
      await expect(run).resolves.toEqual({
        ok: true,
        result: {
          category: 'toolUse',
          executionId: 'exec-1',
          outcome: 'cancelled',
          streamId: 'stream-1',
        },
      });
      expect(mocks.finalizeExecution).toHaveBeenCalledOnce();
    },
  );

  it('forwards a failed shutdown drain to the runtime release hook', async () => {
    const { platform, executeCliRequest } = await installFakePlatform();
    const drainError = new Error('snapshot drain failed');
    mocks.releaseExecutionLeaseAfterArtifacts.mockRejectedValueOnce(drainError);
    const runWithOwnership = vi.fn((operation: () => unknown) => operation());
    let leaseOptions: LeaseOptions | undefined;
    const hangingRun = stubHangingRun((options) => {
      leaseOptions = options;
    });

    const run = executeCliRequest(baseRequest(), cliContext(), {
      registerExecution: true,
    });
    await vi.waitFor(() => expect(leaseOptions).toBeDefined());
    leaseOptions?.onExecutionLeaseAcquired?.(
      runWithOwnership,
      'exec-1' as ExecutionId,
    );
    const shutdown = platform.lifecycle.runShutdown();

    await expect(leaseOptions?.beforeLeaseRelease?.()).rejects.toBe(drainError);
    hangingRun.resolve(COMPLETED_RUN);
    await shutdown;
    await run;
  });

  it('does not finalize shutdown through a captured lease that is already lost', async () => {
    const { platform, executeCliRequest } = await installFakePlatform();
    // Imported dynamically (matching the module above) so the `instanceof`
    // check in runExecution.ts sees the same module instance even after an
    // earlier test's `vi.resetModules()` in this file.
    const { ExecutionLeaseLostError } =
      await import('@agent/storage/executionLease');
    const hangingRun = stubHangingRun((options) => {
      options.onExecutionLeaseAcquired?.(() => {
        throw new ExecutionLeaseLostError('exec-1');
      }, 'exec-1' as ExecutionId);
    });

    const run = executeCliRequest(baseRequest(), cliContext(), {
      registerExecution: true,
    });
    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledOnce());
    const shutdown = platform.lifecycle.runShutdown();
    await Promise.resolve();
    expect(mocks.finalizeExecution).not.toHaveBeenCalled();

    hangingRun.resolve(COMPLETED_RUN);
    await shutdown;
    await run;
    expect(mocks.finalizeExecution).not.toHaveBeenCalled();
  });

  it('closes the runtime host when shutdown finalization fails', async () => {
    const { platform, executeCliRequest } = await installFakePlatform();
    const persistenceError = new Error('terminal metadata disk full');
    mocks.finalizeExecution.mockResolvedValue({
      status: 'failed',
      error: persistenceError,
      stage: 'terminal-status',
      outcomePersisted: false,
    });
    const hangingRun = stubHangingRun((options) => {
      options.onExecutionLeaseAcquired?.(
        (operation: () => unknown) => operation(),
        'exec-1' as ExecutionId,
      );
    });

    const run = executeCliRequest(baseRequest(), cliContext(), {
      registerExecution: true,
    });
    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledOnce());
    const shutdown = platform.lifecycle.runShutdown();
    await Promise.resolve();
    expect(mocks.emit).not.toHaveBeenCalled();
    mocks.readCliRunOutcome.mockResolvedValueOnce('cancelled');
    hangingRun.resolve(COMPLETED_RUN);
    await shutdown;
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('requestShowError', {
      message:
        'Failed to persist cancelled status for execution exec-1: terminal metadata disk full',
    });

    await expect(run).resolves.toEqual({
      ok: true,
      result: {
        category: 'toolUse',
        executionId: 'exec-1',
        outcome: 'cancelled',
        streamId: 'stream-1',
      },
    });
    expect(mocks.finalizeExecution).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('removes the shutdown status hook after owned executions finish', async () => {
    const { platform, executeCliRequest } = await installFakePlatform();
    const request = baseRequest();

    await executeCliRequest(request, cliContext(), {
      registerExecution: true,
    });
    mocks.finalizeExecution.mockClear();
    await platform.lifecycle.runShutdown();

    expect(mocks.finalizeExecution).not.toHaveBeenCalled();
  });
});

describe('executeCliConfig', () => {
  beforeEach(async () => {
    stubRunExecutionDeps();
    await installFreshDefaultSession();
  });

  /** Stubs a completed tool-use run and drives executeCliToolUseConfig. */
  async function runCompletedToolUseConfig(resolvedOutcome: string) {
    const { AgentCategory } = await import('@shared/schemas/agent');
    const { executeCliToolUseConfig } = await loadRunExecution();
    mocks.runAgent.mockResolvedValueOnce({
      category: AgentCategory.ToolUse,
      executionId: 'exec-1',
      outcome: 'completed',
      response: 'Done.',
    });
    mocks.readCliRunOutcome.mockResolvedValueOnce(resolvedOutcome);
    return executeCliToolUseConfig(toolUseConfig(), cliContext(), {
      registerExecution: true,
      stopAfterCycle: true,
    });
  }

  /** Stubs a workflow-category result where a tool-use run was expected. */
  async function runWorkflowCategoryMismatch() {
    const { AgentCategory } = await import('@shared/schemas/agent');
    const { executeCliConfig } = await loadRunExecution();
    mocks.runAgent.mockResolvedValueOnce({
      category: AgentCategory.Workflow,
      executionId: 'exec-1',
      outcome: 'completed',
      outputs: [],
      compileFailures: [],
    });
    return executeCliConfig(toolUseConfig(), cliContext(), {
      expectedCategory: AgentCategory.ToolUse,
      categoryMismatchMessage: 'wrong category',
    });
  }

  it('reports invalid configs without starting the runtime host', async () => {
    const { executeCliConfig } = await loadRunExecution();
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
        'executionId',
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

  it('marks executions errored when the resolved category is unexpected', async () => {
    const result = await runWorkflowCategoryMismatch();

    expect(result).toMatchObject({ ok: false });
    expect(mocks.finalizeExecution).toHaveBeenCalledWith({
      executionId: expect.any(String),
      outcome: RUN_OUTCOME.FAILED,
      flowRecord: 'delete',
    });
    expect(mocks.writeTextStderr).toHaveBeenCalledWith('wrong category');
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('reports category finalization failures and still returns the mismatch', async () => {
    mocks.finalizeExecution.mockResolvedValueOnce({
      status: 'failed',
      error: new Error('terminal metadata disk full'),
      stage: 'terminal-status',
      outcomePersisted: false,
    });

    await expect(runWorkflowCategoryMismatch()).resolves.toEqual({
      ok: false,
      exitCode: CliExitCode.AgentError,
    });

    expect(mocks.writeTextStderr).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(
        /^Warning: Failed to persist failed status for execution .+: terminal metadata disk full$/,
      ),
    );
    expect(mocks.writeTextStderr).toHaveBeenNthCalledWith(2, 'wrong category');
  });
});
