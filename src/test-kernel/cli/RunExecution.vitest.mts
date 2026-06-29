import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import type { CliContext } from '@cli/runtime/cliContext';
import { EXECUTION_STATUS } from '@shared/schemas';
import { DIAGNOSTICS_ADD_RUNTIME_CAPABILITY } from '@tools/diagnosticsRuntimeCapabilities';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createCliRuntimeHost: vi.fn(),
  installCliApprovalHandlers: vi.fn(),
  prepareInteractivePrompt: vi.fn(),
  readCliTerminalStatus: vi.fn(),
  runAgent: vi.fn(),
  writeTextStderr: vi.fn(),
  writeTerminalStatus: vi.fn(),
}));

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
  installCliApprovalHandlers: mocks.installCliApprovalHandlers,
}));

vi.mock('@cli/runtime/terminalStatus', () => ({
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

describe('executeCliRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.close.mockResolvedValue(undefined);
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
  });

  it('marks headless never runs as approval-unavailable for agent execution', async () => {
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const request = {
      config: {},
      executionId: 'exec-1',
    } as Parameters<typeof executeCliRequest>[0];

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
    const request = {
      config: {},
      executionId: 'exec-1',
    } as Parameters<typeof executeCliRequest>[0];

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
    const request = {
      config: {},
      executionId: 'exec-1',
    } as Parameters<typeof executeCliRequest>[0];

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
    const request = {
      config: {},
      executionId: 'exec-1',
    } as Parameters<typeof executeCliRequest>[0];

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
    const request = {
      config: {},
      executionId: 'exec-1',
    } as Parameters<typeof executeCliRequest>[0];

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
    const request = {
      config: {},
      executionId: 'exec-1',
    } as Parameters<typeof executeCliRequest>[0];
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
    const request = {
      config: {},
      executionId: 'exec-1',
    } as Parameters<typeof executeCliRequest>[0];
    const uninstall = vi.fn();
    mocks.installCliApprovalHandlers.mockReturnValue(uninstall);

    await executeCliRequest(request, cliContext());

    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(uninstall.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.close.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('marks owned executions interrupted during platform shutdown', async () => {
    const { initPlatform } = await import('@platform/platform');
    const platform = createFakePlatform();
    initPlatform(platform);
    const { executeCliRequest } = await import('@cli/runtime/runExecution');
    const request = {
      config: {},
      executionId: 'exec-1',
    } as Parameters<typeof executeCliRequest>[0];
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
    const request = {
      config: {},
      executionId: 'exec-1',
    } as Parameters<typeof executeCliRequest>[0];

    await executeCliRequest(request, cliContext(), {
      registerExecution: true,
    });
    mocks.writeTerminalStatus.mockClear();
    await platform.lifecycle.runShutdown();

    expect(mocks.writeTerminalStatus).not.toHaveBeenCalled();
  });
});

describe('executeCliConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.close.mockResolvedValue(undefined);
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

    const result = await executeCliConfig(
      {
        agent: 'chat',
        model: 'gpt54',
        inputFiles: [],
        contextFiles: [],
        instruction: 'Check this.',
        workingDirectory: '/tmp/project',
        agentCategory: AgentCategory.ToolUse,
      },
      cliContext(),
      {
        expectedCategory: AgentCategory.ToolUse,
        categoryMismatchMessage: 'wrong category',
      },
    );

    expect(result).toMatchObject({ ok: false });
    expect(mocks.writeTerminalStatus).toHaveBeenCalledWith(
      expect.any(String),
      EXECUTION_STATUS.ERROR,
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith('wrong category');
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
