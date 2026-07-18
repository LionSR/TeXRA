import { mkdtemp } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { cleanupTempDirs } from '@test/support/tempDirPlatform';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { CliContext } from '@cli/runtime/cliContext';
import type { executeCliRequest } from '@cli/runtime/runExecution';
import { AgentError } from '@common/errors';
import {
  EXECUTION_STATUS,
  type ExecutionId,
  type StorageKey,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { DIAGNOSTICS_READ_RUNTIME_CAPABILITY } from '@tools/diagnosticsRuntimeCapabilities';
import { SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES } from '@tools/setup/platform';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  emit: vi.fn(),
  detachRunProgressRenderer: vi.fn(),
  detachSessionProgressProjection: vi.fn(),
  createHeadlessCliHostInteractions: vi.fn(),
  createCliRuntimeHost: vi.fn(),
  disposeHostInteractions: vi.fn(),
  prepareInteractivePrompt: vi.fn(),
  readCliRunOutcome: vi.fn(),
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

vi.mock('@agent/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage')>()),
  finalizeExecution: mocks.finalizeExecution,
}));

vi.mock('@cli/runtime/runtimeHost', () => ({
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

vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStderr: mocks.writeTextStderr,
}));

function cliContext(overrides: Partial<CliContext> = {}): CliContext {
  return createTestCliContext(overrides);
}

function baseRequest(): Parameters<typeof executeCliRequest>[0] {
  return {
    config: {},
    executionId: 'exec-1',
  } as Parameters<typeof executeCliRequest>[0];
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

function stubRunExecutionDeps(): void {
  vi.clearAllMocks();
  mocks.close.mockResolvedValue(undefined);
  mocks.detachRunProgressRenderer.mockReturnValue(undefined);
  mocks.createHeadlessCliHostInteractions.mockReturnValue({
    pending: vi.fn(() => []),
    resolve: vi.fn(() => false),
    cancel: vi.fn(),
    dispose: mocks.disposeHostInteractions,
  });
  mocks.createCliRuntimeHost.mockReturnValue({
    emit: mocks.emit,
    attachRunProgressRenderer: vi.fn(() => mocks.detachRunProgressRenderer),
    prepareInteractivePrompt: mocks.prepareInteractivePrompt,
    close: mocks.close,
  });
  mocks.readCliRunOutcome.mockResolvedValue('completed');
  mocks.finalizeExecution.mockResolvedValue({
    status: 'durable',
    terminalStatusPersisted: true,
    flowRecord: 'deleted',
  });
  mocks.runAgent.mockResolvedValue({
    category: 'toolUse',
    executionId: 'exec-1',
    outcome: 'completed',
    streamId: 'stream-1',
  });
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
      const { executeCliRequest } = await import('@cli/runtime/runExecution');
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
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
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

  it('marks headless never runs as approval-unavailable for agent execution', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const request = baseRequest();

    await executeCliRequest(request, cliContext());

    expect(mocks.runAgent).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        approvalPromptsUnavailable: true,
      }),
    );
  });

  it('marks headless ask runs as approval-unavailable for agent execution', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const request = baseRequest();

    await executeCliRequest(request, cliContext({ approvalPolicy: 'ask' }));

    expect(mocks.runAgent).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        approvalPromptsUnavailable: true,
      }),
    );
  });

  it('keeps yolo runs approval-available for agent execution', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const request = baseRequest();

    await executeCliRequest(request, cliContext({ approvalPolicy: 'yolo' }));

    expect(mocks.runAgent).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        approvalPromptsUnavailable: false,
      }),
    );
  });

  it('hides host-unavailable tools in CLI execution', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
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
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
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
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const request = baseRequest();
    const context = cliContext({ mode: 'interactive', approvalPolicy: 'ask' });

    await executeCliRequest(request, context);

    expect(mocks.createHeadlessCliHostInteractions).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ beforePrompt: expect.any(Function) }),
    );

    const hooks = mocks.createHeadlessCliHostInteractions.mock
      .calls[0]?.[1] as {
      beforePrompt?: () => void;
    };
    hooks.beforePrompt?.();
    expect(mocks.prepareInteractivePrompt).toHaveBeenCalledTimes(1);
  });

  it('restores CLI host interactions before closing the runtime host', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
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
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
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
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
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

      await getExecutionStore(executionId).writeConfig(config);
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
    expect(snapshot.description).toBe('chat / gpt54');
    expect(snapshot.parentStreamId).toBe(parentStreamId);
    expect(reader.getTaskState(streamId)?.agentConfig).toMatchObject({
      agent: 'chat',
      model: 'gpt54',
      agentCategory: 'toolUse',
    });
  });

  it('uses an opened persistent store and flushes it after the run', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const { defaultSession } = await import('@agent/runtime/SessionHandle');
    const request = baseRequest();
    const store = defaultSession().transcripts;
    const callOrder: string[] = [];
    vi.spyOn(store, 'flush').mockImplementation(async () => {
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
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const { defaultSession } = await import('@agent/runtime/SessionHandle');
    const request = baseRequest();
    const store = defaultSession().transcripts;
    const flushSpy = vi.spyOn(store, 'flush').mockResolvedValue(undefined);
    mocks.runAgent.mockRejectedValueOnce(new AgentError('boom'));

    // #7645: a classified run failure resolves to a non-zero exit code
    // instead of rethrowing — otherwise it reaches bin/texra.ts's crash
    // handler and gets misreported as an unexpected crash (double-printed
    // message + a false "please report it" line).
    const result = await executeCliRequest(request, cliContext());

    expect(result).toEqual({ ok: false, exitCode: CliExitCode.AgentError });
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-AgentError rejection instead of swallowing it into an exit code', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const { defaultSession } = await import('@agent/runtime/SessionHandle');
    const request = baseRequest();
    const store = defaultSession().transcripts;
    const flushSpy = vi.spyOn(store, 'flush').mockResolvedValue(undefined);
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

  it('does not finalize a classified run failure a second time', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const request = baseRequest();
    mocks.runAgent.mockImplementationOnce(
      async (_request: unknown, options: { readonly onRun?: () => void }) => {
        options.onRun?.();
        throw new AgentError('provider boom');
      },
    );

    await expect(executeCliRequest(request, cliContext())).resolves.toEqual({
      ok: false,
      exitCode: CliExitCode.AgentError,
    });

    expect(mocks.finalizeExecution).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed run terminal status when wrap cleanup fails after invoke succeeded (#7863)', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
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
      terminalStatus: EXECUTION_STATUS.ERROR,
      flowRecord: 'delete',
    });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('resolves a classified run failure to a non-zero exit code without rethrowing', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
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

  it('maps a classified run failure to ApprovalDenied when the run denied approval', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const { markApprovalDenied } =
      await import('@cli/runtime/approval/approvalPolicy');
    const request = baseRequest();
    const context = cliContext();
    markApprovalDenied(context);
    mocks.runAgent.mockRejectedValueOnce(new AgentError('approval denied'));

    const result = await executeCliRequest(request, context);

    expect(result).toEqual({
      ok: false,
      exitCode: CliExitCode.ApprovalDenied,
    });
  });

  it('closes the runtime host when sidecar flush fails', async () => {
    vi.resetModules();
    const flushError = new Error('flush failed');
    vi.doMock('@transcript', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@transcript')>();
      return {
        ...actual,
        StreamSnapshotStore: class {
          attachSessionEvents = vi.fn(() => vi.fn());

          handleProgressEvent = vi.fn();

          flush = vi.fn(async () => {
            throw flushError;
          });
        },
      };
    });

    try {
      await installFreshDefaultSession();
      const { executeCliRequest } = await import('@cli/runtime/runExecution');
      const request = baseRequest();

      await expect(executeCliRequest(request, cliContext())).rejects.toThrow(
        flushError,
      );

      expect(mocks.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('@transcript');
      vi.resetModules();
      await installFreshDefaultSession();
    }
  });

  it('marks owned executions interrupted during platform shutdown', async () => {
    const { initPlatform } = await import('@platform/platform');
    const platform = createFakePlatform();
    initPlatform(platform);
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const request = baseRequest();
    let resolveRun:
      | ((result: Awaited<ReturnType<typeof mocks.runAgent>>) => void)
      | undefined;
    mocks.runAgent.mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
    );

    const run = executeCliRequest(request, cliContext(), {
      registerExecution: true,
    });
    await Promise.resolve();
    await platform.lifecycle.runShutdown();

    expect(mocks.finalizeExecution).toHaveBeenCalledWith({
      executionId: 'exec-1',
      terminalStatus: EXECUTION_STATUS.INTERRUPTED,
      flowRecord: 'preserve',
    });
    resolveRun?.({
      category: 'toolUse',
      executionId: 'exec-1',
      outcome: 'completed',
      streamId: 'stream-1',
    });
    mocks.readCliRunOutcome.mockResolvedValueOnce('cancelled');
    await expect(run).resolves.toEqual({
      ok: true,
      result: {
        category: 'toolUse',
        executionId: 'exec-1',
        outcome: 'cancelled',
        streamId: 'stream-1',
      },
    });
    expect(mocks.finalizeExecution).toHaveBeenCalledTimes(2);
    expect(mocks.finalizeExecution).toHaveBeenLastCalledWith({
      executionId: 'exec-1',
      terminalStatus: EXECUTION_STATUS.INTERRUPTED,
      flowRecord: 'preserve',
    });
  });

  it('closes the runtime host when shutdown finalization fails', async () => {
    const { initPlatform } = await import('@platform/platform');
    const platform = createFakePlatform();
    initPlatform(platform);
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const persistenceError = new Error('terminal metadata disk full');
    mocks.finalizeExecution.mockResolvedValue({
      status: 'failed',
      error: persistenceError,
      stage: 'terminal-status',
      terminalStatusPersisted: false,
    });
    let resolveRun:
      | ((result: Awaited<ReturnType<typeof mocks.runAgent>>) => void)
      | undefined;
    mocks.runAgent.mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
    );

    const run = executeCliRequest(baseRequest(), cliContext(), {
      registerExecution: true,
    });
    await Promise.resolve();
    await platform.lifecycle.runShutdown();
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('requestShowError', {
      message:
        'Failed to persist interrupted status for execution exec-1: terminal metadata disk full',
    });
    resolveRun?.({
      category: 'toolUse',
      executionId: 'exec-1',
      outcome: 'completed',
      streamId: 'stream-1',
    });
    mocks.readCliRunOutcome.mockResolvedValueOnce('cancelled');

    await expect(run).resolves.toEqual({
      ok: true,
      result: {
        category: 'toolUse',
        executionId: 'exec-1',
        outcome: 'cancelled',
        streamId: 'stream-1',
      },
    });
    expect(mocks.finalizeExecution).toHaveBeenCalledTimes(2);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('removes the shutdown status hook after owned executions finish', async () => {
    const { initPlatform } = await import('@platform/platform');
    const platform = createFakePlatform();
    initPlatform(platform);
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
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

  it('reports invalid configs without starting the runtime host', async () => {
    const { executeCliConfig } = await import('@cli/runtime/runExecution');
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
    const { AgentCategory } =
      await import('@agent/core/definition/AgentDataclass');
    const { executeCliToolUseConfig } =
      await import('@cli/runtime/runExecution');
    mocks.runAgent.mockResolvedValueOnce({
      category: AgentCategory.ToolUse,
      executionId: 'exec-1',
      outcome: 'completed',
      lastResponse: 'Done.',
    });
    mocks.readCliRunOutcome.mockResolvedValueOnce('completed');

    const result = await executeCliToolUseConfig(
      toolUseConfig(),
      cliContext(),
      {
        registerExecution: true,
        stopAfterCycle: true,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      result: {
        outcome: 'completed',
        workingDirectory: '/tmp/project',
        lastResponse: 'Done.',
      },
    });
    if (result.ok) {
      expect(Object.keys(result.result)).toEqual([
        'category',
        'executionId',
        'outcome',
        'lastResponse',
        'workingDirectory',
      ]);
    }
  });

  it('carries only the resolved outcome after a shutdown interruption', async () => {
    const { AgentCategory } =
      await import('@agent/core/definition/AgentDataclass');
    const { executeCliToolUseConfig } =
      await import('@cli/runtime/runExecution');
    mocks.runAgent.mockResolvedValueOnce({
      category: AgentCategory.ToolUse,
      executionId: 'exec-1',
      outcome: 'completed',
      lastResponse: 'Done.',
    });
    mocks.readCliRunOutcome.mockResolvedValueOnce('cancelled');

    const result = await executeCliToolUseConfig(
      toolUseConfig(),
      cliContext(),
      {
        registerExecution: true,
        stopAfterCycle: true,
      },
    );

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
    const { AgentCategory } =
      await import('@agent/core/definition/AgentDataclass');
    const { executeCliConfig } = await import('@cli/runtime/runExecution');
    mocks.runAgent.mockResolvedValueOnce({
      category: AgentCategory.Workflow,
      executionId: 'exec-1',
      outcome: 'completed',
      outputs: [],
      compileFailures: [],
    });

    const result = await executeCliConfig(toolUseConfig(), cliContext(), {
      expectedCategory: AgentCategory.ToolUse,
      categoryMismatchMessage: 'wrong category',
    });

    expect(result).toMatchObject({ ok: false });
    expect(mocks.finalizeExecution).toHaveBeenCalledWith({
      executionId: expect.any(String),
      terminalStatus: EXECUTION_STATUS.ERROR,
      flowRecord: 'delete',
    });
    expect(mocks.writeTextStderr).toHaveBeenCalledWith('wrong category');
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('reports category finalization failures and still returns the mismatch', async () => {
    const { AgentCategory } =
      await import('@agent/core/definition/AgentDataclass');
    const { executeCliConfig } = await import('@cli/runtime/runExecution');
    mocks.runAgent.mockResolvedValueOnce({
      category: AgentCategory.Workflow,
      executionId: 'exec-1',
      outcome: 'completed',
      outputs: [],
      compileFailures: [],
    });
    mocks.finalizeExecution.mockResolvedValueOnce({
      status: 'failed',
      error: new Error('terminal metadata disk full'),
      stage: 'terminal-status',
      terminalStatusPersisted: false,
    });

    await expect(
      executeCliConfig(toolUseConfig(), cliContext(), {
        expectedCategory: AgentCategory.ToolUse,
        categoryMismatchMessage: 'wrong category',
      }),
    ).resolves.toEqual({ ok: false, exitCode: CliExitCode.AgentError });

    expect(mocks.writeTextStderr).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(
        /^Warning: Failed to persist error status for execution .+: terminal metadata disk full$/,
      ),
    );
    expect(mocks.writeTextStderr).toHaveBeenNthCalledWith(2, 'wrong category');
  });
});
