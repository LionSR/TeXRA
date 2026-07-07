import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { CliContext } from '@cli/runtime/cliContext';
import type { executeCliRequest } from '@cli/runtime/runExecution';
import {
  EXECUTION_STATUS,
  type StorageKey,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { DIAGNOSTICS_ADD_RUNTIME_CAPABILITY } from '@tools/diagnosticsRuntimeCapabilities';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createHeadlessCliHostInteractions: vi.fn(),
  createCliRuntimeHost: vi.fn(),
  installCliApprovalHandlers: vi.fn(),
  prepareInteractivePrompt: vi.fn(),
  readCliTerminalStatus: vi.fn(),
  runAgent: vi.fn(),
  writeTextStderr: vi.fn(),
  writeTerminalStatus: vi.fn(),
}));

const tempDirs: string[] = [];

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

vi.mock('@agent/storage', () => ({
  writeTerminalStatus: mocks.writeTerminalStatus,
}));

vi.mock('@cli/runtime/runtimeHost', () => ({
  createCliRuntimeHost: mocks.createCliRuntimeHost,
}));

vi.mock('@cli/runtime/approvalAdapter', () => ({
  createHeadlessCliHostInteractions: mocks.createHeadlessCliHostInteractions,
  installCliApprovalHandlers: mocks.installCliApprovalHandlers,
}));

vi.mock('@cli/runtime/terminalStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/terminalStatus')>()),
  readCliTerminalStatus: mocks.readCliTerminalStatus,
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStderr: mocks.writeTextStderr,
}));

function cliContext(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: '/tmp/project',
    mode: 'headless',
    outputFormat: 'text',
    approvalPolicy: 'never',
    stderrIsTty: false,
    stdoutColorEnabled: false,
    stderrColorEnabled: false,
    colorEnabled: false,
    version: '0.0.0',
    resourcesPath: '/tmp/resources',
    ...overrides,
  };
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
  mocks.createHeadlessCliHostInteractions.mockReturnValue({
    handleProgressEvent: vi.fn(() => false),
    pending: vi.fn(() => []),
    resolve: vi.fn(() => false),
    cancel: vi.fn(),
  });
  mocks.installCliApprovalHandlers.mockReturnValue(vi.fn());
  mocks.createCliRuntimeHost.mockReturnValue({
    emit: vi.fn(),
    prepareInteractivePrompt: mocks.prepareInteractivePrompt,
    close: mocks.close,
  });
  mocks.readCliTerminalStatus.mockResolvedValue('completed');
  mocks.runAgent.mockResolvedValue({
    category: 'toolUse',
    executionId: 'exec-1',
    status: 'completed',
    streamId: 'stream-1',
  });
}

describe('executeCliRequest', () => {
  beforeEach(stubRunExecutionDeps);

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
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
          'list_api_keys',
          'inline_comment',
          DIAGNOSTICS_ADD_RUNTIME_CAPABILITY,
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
          'list_api_keys',
          'inline_comment',
          DIAGNOSTICS_ADD_RUNTIME_CAPABILITY,
          'custom_tool',
        ],
      }),
    );
  });

  it('installs CLI approval handlers with the runtime prompt hook', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const request = baseRequest();
    const context = cliContext({ mode: 'interactive', approvalPolicy: 'ask' });

    await executeCliRequest(request, context);

    expect(mocks.installCliApprovalHandlers).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ beforePrompt: expect.any(Function) }),
    );

    const hooks = mocks.installCliApprovalHandlers.mock.calls[0]?.[1] as {
      beforePrompt?: () => void;
    };
    hooks.beforePrompt?.();
    expect(mocks.prepareInteractivePrompt).toHaveBeenCalledTimes(1);
  });

  it('restores CLI approval handlers before closing the runtime host', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const request = baseRequest();
    const uninstall = vi.fn();
    mocks.installCliApprovalHandlers.mockReturnValue(uninstall);

    await executeCliRequest(request, cliContext());

    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(uninstall.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.close.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('persists headless stream sidecars from session events without double-counting legacy host usage', async () => {
    await installStoragePlatform();
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const request = baseRequest();
    const streamId = 'stream-1' as StreamTabId;
    const todo: TodoItem = {
      content: 'Write the introduction',
      status: 'in_progress',
      activeForm: 'Writing the introduction',
    };

    mocks.runAgent.mockImplementationOnce(async (_request, options) => {
      const { defaultSession } = await import('@agent/runtime/SessionHandle');
      const { toRunFactDomainKey } =
        await import('@agent/runtime/runFactEvents');
      defaultSession().events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'domain',
          key: toRunFactDomainKey('updateTodos'),
          data: {
            streamId,
            todos: [todo],
          },
        },
      });
      defaultSession().events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'usage',
          stats: { inputTokens: 100, outputTokens: 20, cost: 0.5 },
          data: {
            streamId,
            storageKey: 'run-1' as StorageKey,
            usage: { inputTokens: 100, outputTokens: 20, cost: 0.5 },
          },
        },
      });
      // This is the legacy projected event still visible on the public host
      // channel. It must not be persisted a second time by the CLI bridge.
      options.runtimeHost.emit('updateStreamUsage', {
        streamId,
        storageKey: 'run-1' as StorageKey,
        usage: { inputTokens: 100, outputTokens: 20, cost: 0.5 },
      });
      options.runtimeHost.emit('updateTodos', {
        streamId,
        todos: [todo],
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
    const snapshot = await new StreamSnapshotStore().read(streamId);
    expect(snapshot.todos).toEqual([todo]);
    expect(snapshot.runUsage['run-1']).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cost: 0.5,
    });
  });

  it('loads the stream log store before the run and flushes it after, in order', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const { getDefaultStreamLogStore } = await import('@transcript');
    const request = baseRequest();
    const store = getDefaultStreamLogStore();
    const callOrder: string[] = [];
    vi.spyOn(store, 'load').mockImplementation(async () => {
      callOrder.push('load');
    });
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

    // The bug this test guards: StreamLogStore.save()/flush() silently no-op
    // until .load() has run once, so headless runs lost their whole
    // streamLogs timeline. `load` must precede the run, `flush` must follow it.
    expect(callOrder).toEqual(['load', 'runAgent', 'flush']);
  });

  it('flushes the stream log store even when the run throws', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const { getDefaultStreamLogStore } = await import('@transcript');
    const request = baseRequest();
    const store = getDefaultStreamLogStore();
    const loadSpy = vi.spyOn(store, 'load').mockResolvedValue(undefined);
    const flushSpy = vi.spyOn(store, 'flush').mockResolvedValue(undefined);
    mocks.runAgent.mockRejectedValueOnce(new Error('boom'));

    await expect(executeCliRequest(request, cliContext())).rejects.toThrow(
      'boom',
    );

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledTimes(1);
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
      const { executeCliRequest } = await import('@cli/runtime/runExecution');
      const request = baseRequest();

      await expect(executeCliRequest(request, cliContext())).rejects.toThrow(
        flushError,
      );

      expect(mocks.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('@transcript');
      vi.resetModules();
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

    expect(mocks.writeTerminalStatus).toHaveBeenCalledWith(
      'exec-1',
      EXECUTION_STATUS.INTERRUPTED,
    );

    resolveRun?.({
      category: 'toolUse',
      executionId: 'exec-1',
      status: 'completed',
      streamId: 'stream-1',
    });
    await run;
    expect(mocks.writeTerminalStatus).toHaveBeenCalledTimes(2);
    expect(mocks.writeTerminalStatus).toHaveBeenLastCalledWith(
      'exec-1',
      EXECUTION_STATUS.INTERRUPTED,
    );
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
    mocks.writeTerminalStatus.mockClear();
    await platform.lifecycle.runShutdown();

    expect(mocks.writeTerminalStatus).not.toHaveBeenCalled();
  });
});

describe('executeCliConfig', () => {
  beforeEach(stubRunExecutionDeps);

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

  it('derives the CLI display result and exit code for tool-use configs', async () => {
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
    mocks.readCliTerminalStatus.mockResolvedValueOnce(
      EXECUTION_STATUS.COMPLETED,
    );

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
      displayResult: {
        status: EXECUTION_STATUS.COMPLETED,
        terminalStatus: EXECUTION_STATUS.COMPLETED,
        workingDirectory: '/tmp/project',
        lastResponse: 'Done.',
      },
    });
  });

  it('uses the resolved terminal status for tool-use JSON output', async () => {
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
    mocks.readCliTerminalStatus.mockResolvedValueOnce(
      EXECUTION_STATUS.INTERRUPTED,
    );

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
      displayResult: {
        status: EXECUTION_STATUS.INTERRUPTED,
        terminalStatus: EXECUTION_STATUS.INTERRUPTED,
        endGroupStatus: 'stopped',
        workingDirectory: '/tmp/project',
      },
    });
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
    expect(mocks.writeTerminalStatus).toHaveBeenCalledWith(
      expect.any(String),
      EXECUTION_STATUS.ERROR,
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith('wrong category');
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
