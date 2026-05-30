import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '@cli/runtime/cliContext';

const mocks = vi.hoisted(() => ({
  executeCliRequest: vi.fn(),
  expandRunInputs: vi.fn(),
  getToolUseAgents: vi.fn(),
  getWorkflowAgents: vi.fn(),
  initCliPlatform: vi.fn(),
  installCliApprovalHandlers: vi.fn(),
  isAuthenticated: vi.fn(),
  loadAgents: vi.fn(),
  writeTextStderr: vi.fn(),
  writeTextStdout: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  getToolUseAgents: mocks.getToolUseAgents,
  getWorkflowAgents: mocks.getWorkflowAgents,
  loadAgents: mocks.loadAgents,
}));

vi.mock('@agent/storage', () => ({
  writeTerminalStatus: vi.fn(),
}));

vi.mock('@cli/runtime/approvalAdapter', () => ({
  hasCliApprovalDenied: vi.fn(() => false),
  installCliApprovalHandlers: mocks.installCliApprovalHandlers,
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
  initLocalCliPlatform: vi.fn(),
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeNdjsonStdout: vi.fn(),
  writeTextStderr: mocks.writeTextStderr,
  writeTextStdout: mocks.writeTextStdout,
}));

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProvider: () => ({
    isAuthenticated: mocks.isAuthenticated,
  }),
}));

vi.mock('@cli/runtime/multiAgentPresets', () => ({
  cliMultiAgentPlanHasGaps: vi.fn(() => false),
  cliMultiAgentPresetNdjsonRecords: vi.fn(() => []),
  findCliMultiAgentPreset: vi.fn(() => ({
    id: 'mathematician',
    name: 'Mathematician',
    description: 'For math papers.',
    workflowAgents: [],
    toolUseAgents: ['orchestrator'],
    source: 'built-in',
  })),
  formatCliMultiAgentPresetDetails: vi.fn(() => ''),
  formatCliMultiAgentPresetList: vi.fn(() => ''),
  planCliMultiAgentPresetRun: vi.fn(() => ({
    preset: {
      id: 'mathematician',
      name: 'Mathematician',
      source: 'built-in',
    },
    rootAgent: {
      name: 'orchestrator',
      category: 'toolUse',
      source: 'builtInToolUse',
      path: '/agents/orchestrator.yaml',
      tools: ['delegate_agent'],
    },
    missingWorkflowAgents: [],
    missingToolUseAgents: [],
    workflowAgentKeys: [],
    toolUseAgentKeys: ['builtInToolUse:orchestrator'],
  })),
  readCliMultiAgentPresets: vi.fn(() => []),
  withCliMultiAgentPresetVisibility: vi.fn(
    (_plan: unknown, run: () => Promise<unknown>) => run(),
  ),
}));

vi.mock('@cli/commands/_helpers/modelArg', () => ({
  buildHeadlessRunContext: vi.fn((context: CliContext, model: string) => ({
    ...context,
    helperModel: model,
    quietLogs: true,
    renderRunProgress: false,
  })),
  resolveCliRunModel: vi.fn(
    (_context: CliContext, model: string | undefined) => model ?? 'deepseekT',
  ),
}));

vi.mock('@cli/commands/_helpers/runExecution', () => ({
  executeCliRequest: mocks.executeCliRequest,
}));

vi.mock('@cli/commands/_helpers/workflowInputs', () => ({
  expandRunInputs: mocks.expandRunInputs,
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
    colorEnabled: false,
    version: '0.0.0',
    resourcesPath: '/tmp/resources',
    ...overrides,
  };
}

describe('CLI multi-agent run command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expandRunInputs.mockResolvedValue({
      inputFiles: ['problem.tex'],
      contextFiles: [],
    });
    mocks.getWorkflowAgents.mockReturnValue([]);
    mocks.getToolUseAgents.mockReturnValue([
      {
        name: 'orchestrator',
        category: 'toolUse',
        source: 'builtInToolUse',
        path: '/agents/orchestrator.yaml',
        tools: ['delegate_agent'],
      },
    ]);
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.executeCliRequest.mockResolvedValue({
      result: {
        category: 'toolUse',
        executionId: 'exec-1',
        status: 'completed',
        lastResponse: 'The proof is correct.',
      },
      terminalStatus: 'completed',
    });
  });

  it('stops the headless team root after one cycle instead of waiting for a follow-up', async () => {
    const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');

    const exitCode = await runMultiAgentPreset(cliContext(), {
      preset: 'mathematician',
      inputFiles: ['problem.tex'],
      contextFiles: [],
      model: 'deepseekT',
      instruction: 'Inspect the proof without editing files.',
    });

    expect(exitCode).toBe(0);
    expect(mocks.executeCliRequest).toHaveBeenCalledTimes(1);
    expect(mocks.executeCliRequest.mock.calls[0]?.[2]).toMatchObject({
      enforceCategory: true,
      registerExecution: true,
      markErrorOnThrow: true,
      stopAfterCycle: true,
    });
  });
});
