import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { CliContext } from '@cli/runtime/cliContext';

const mocks = vi.hoisted(() => ({
  emitCliResult: vi.fn(),
  getAgent: vi.fn(),
  initLocalCliPlatform: vi.fn(),
  loadAgents: vi.fn(),
  resolveAgentWithRemoteFallback: vi.fn(),
  writeTextStderr: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  getAgent: mocks.getAgent,
  getVisibleAgents: vi.fn(() => []),
  loadAgents: mocks.loadAgents,
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initLocalCliPlatform: mocks.initLocalCliPlatform,
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStderr: mocks.writeTextStderr,
}));

vi.mock('@cli/commands/_helpers/output', () => ({
  emitCliResult: mocks.emitCliResult,
}));

vi.mock('@cli/commands/_helpers/remoteAgents', () => ({
  resolveAgentWithRemoteFallback: mocks.resolveAgentWithRemoteFallback,
}));

function cliContext(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: '/tmp/project',
    mode: 'headless',
    outputFormat: 'text',
    approvalPolicy: 'never',
    quietLogs: false,
    renderRunProgress: true,
    stderrIsTty: false,
    stdoutColorEnabled: false,
    stderrColorEnabled: false,
    colorEnabled: false,
    version: '0.0.0',
    resourcesPath: '/tmp/resources',
    ...overrides,
  };
}

describe('CLI agents command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the local registry match for agent details before remote fallback', async () => {
    const localAgent = {
      name: 'lean',
      source: 'builtInToolUse',
      path: '/tmp/resources/tool_use_agents/lean.yaml',
      category: AgentCategory.ToolUse,
      description: 'Lean 4 proof assistant.',
      tools: ['lean_diagnostics'],
    };
    mocks.getAgent.mockReturnValue(localAgent);
    const { showAgent } = await import('@cli/commands/agents');

    const exitCode = await showAgent(cliContext(), 'lean');

    expect(exitCode).toBe(0);
    expect(mocks.initLocalCliPlatform).toHaveBeenCalledTimes(1);
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expect(mocks.getAgent).toHaveBeenCalledWith('lean');
    expect(mocks.resolveAgentWithRemoteFallback).not.toHaveBeenCalled();
    expect(mocks.emitCliResult).toHaveBeenCalledWith(expect.anything(), {
      json: localAgent,
      ndjson: { kind: 'agent', agent: localAgent },
      text: expect.stringContaining('source: builtInToolUse'),
    });
  });

  it('uses the remote fallback resolver when local lookup misses', async () => {
    const remoteAgent = {
      name: 'orchestrator',
      source: 'remote',
      path: '',
      category: AgentCategory.ToolUse,
      description: 'Coordinates multi-agent work.',
      tools: ['delegate_agent', 'delegate_workflow'],
      visibility: ['public'],
    };
    mocks.getAgent.mockReturnValue(undefined);
    mocks.resolveAgentWithRemoteFallback.mockResolvedValue(remoteAgent);
    const { showAgent } = await import('@cli/commands/agents');

    const exitCode = await showAgent(cliContext(), 'orchestrator');

    expect(exitCode).toBe(0);
    expect(mocks.initLocalCliPlatform).toHaveBeenCalledTimes(1);
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expect(mocks.resolveAgentWithRemoteFallback).toHaveBeenCalledWith(
      'orchestrator',
    );
    expect(mocks.emitCliResult).toHaveBeenCalledWith(expect.anything(), {
      json: remoteAgent,
      ndjson: { kind: 'agent', agent: remoteAgent },
      text: expect.stringContaining('source: remote'),
    });
  });

  it('reports missing agents after the remote fallback is exhausted', async () => {
    mocks.getAgent.mockReturnValue(undefined);
    mocks.resolveAgentWithRemoteFallback.mockResolvedValue(undefined);
    const { showAgent } = await import('@cli/commands/agents');

    const exitCode = await showAgent(cliContext(), 'missing-agent');

    expect(exitCode).toBe(2);
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Agent not found: missing-agent',
    );
    expect(mocks.emitCliResult).not.toHaveBeenCalled();
  });
});
