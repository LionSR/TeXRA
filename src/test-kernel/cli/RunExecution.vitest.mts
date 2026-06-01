import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '@cli/runtime/cliContext';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createCliRuntimeHost: vi.fn(),
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

vi.mock('@cli/commands/_helpers/terminalStatus', () => ({
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
    mocks.createCliRuntimeHost.mockReturnValue({
      emit: vi.fn(),
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
    const { executeCliRequest } =
      await import('@cli/commands/_helpers/runExecution');
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
    const { executeCliRequest } =
      await import('@cli/commands/_helpers/runExecution');
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
    const { executeCliRequest } =
      await import('@cli/commands/_helpers/runExecution');
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
});
