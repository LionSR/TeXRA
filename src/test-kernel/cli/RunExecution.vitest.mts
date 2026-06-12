import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '@cli/runtime/cliContext';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createCliRuntimeHost: vi.fn(),
  installCliApprovalHandlers: vi.fn(),
  prepareInteractivePrompt: vi.fn(),
  readCliTerminalStatus: vi.fn(),
  runAgent: vi.fn(),
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
});
