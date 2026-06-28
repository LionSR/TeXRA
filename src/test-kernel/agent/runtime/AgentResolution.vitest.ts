import { afterEach, describe, expect, it, vi } from 'vitest';

const agentIndexMock = vi.hoisted(() => ({
  computeAgentOptionsData: vi.fn(),
  findAgentByIdentifier: vi.fn(),
  getAgent: vi.fn(),
  getAgentsByCategory: vi.fn(),
  getAgentsBySource: vi.fn(),
  getVisibleAgents: vi.fn(),
  loadAgents: vi.fn(),
  refresh: vi.fn(),
  toRemoteAgentProfileData: vi.fn(),
}));

const agentLaunchContextMock = vi.hoisted(() => ({
  getAgentPath: vi.fn(),
}));

const agentLoadMock = vi.hoisted(() => ({
  loadAgentDefinitionInspectionData: vi.fn(),
}));

vi.mock('@agent/index', () => agentIndexMock);
vi.mock('@agent/runtime/AgentLaunchContext', () => agentLaunchContextMock);
vi.mock('@agent/runtime/agentLoad', () => agentLoadMock);

import {
  computeRuntimeAgentOptionsData,
  getRuntimeAgent,
  getRuntimeToolUseAgent,
  getRuntimeWorkflowAgent,
  inspectRuntimeAgentDefinition,
  listRuntimeRemoteAgentProfiles,
  listRuntimeAgents,
  loadRuntimeAgents,
  refreshRuntimeAgentCatalog,
  resolveRuntimeAgentIdentifiers,
  runtimeToolUseAgentHasAnyTool,
  type RuntimeAgentEntry,
} from '@agent/runtime/agentResolution';
import { AgentCategory } from '@shared/schemas/agent';

describe('runtime agent resolution', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exposes distinct runtime lookup intentions', () => {
    const entry = {
      category: AgentCategory.ToolUse,
      tools: ['delegate_agent'],
    };
    agentIndexMock.getAgent.mockReturnValue(entry);

    expect(getRuntimeAgent('proof')).toBe(entry);
    expect(getRuntimeAgent('remote:proof')).toBe(entry);
    expect(getRuntimeWorkflowAgent('workflow-proof')).toBe(entry);
    expect(getRuntimeToolUseAgent('proof')).toBe(entry);
    expect(
      runtimeToolUseAgentHasAnyTool('proof', new Set(['delegate_agent'])),
    ).toBe(true);
    expect(agentIndexMock.getAgent).toHaveBeenNthCalledWith(1, 'proof');
    expect(agentIndexMock.getAgent).toHaveBeenCalledWith('remote:proof');
    expect(agentIndexMock.getAgent).toHaveBeenCalledWith(
      'workflow-proof',
      AgentCategory.Workflow,
    );
    expect(agentIndexMock.getAgent).toHaveBeenCalledWith(
      'proof',
      AgentCategory.ToolUse,
    );
  });

  it('resolves candidate identifiers as a batch and reports misses', () => {
    const proof: RuntimeAgentEntry = {
      name: 'proof',
      category: AgentCategory.ToolUse,
      source: 'builtInToolUse',
      path: '/agents/proof.yaml',
    };
    const review: RuntimeAgentEntry = {
      name: 'review',
      category: AgentCategory.ToolUse,
      source: 'builtInToolUse',
      path: '/agents/review.yaml',
    };
    const agents = [proof, review];
    agentIndexMock.findAgentByIdentifier.mockImplementation(
      (entries: typeof agents, identifier: string) =>
        entries.find((entry) => entry.name === identifier),
    );

    expect(
      resolveRuntimeAgentIdentifiers(agents, ['proof', 'missing', 'review']),
    ).toEqual({
      resolved: [proof, review],
      missing: ['missing'],
    });
  });

  it('loads and projects the runtime agent catalog', async () => {
    const options = {
      workflow: [{ value: 'builtIn:workflow', label: 'workflow' }],
      toolUse: [{ value: 'builtInToolUse:proof', label: 'proof' }],
    };
    agentIndexMock.loadAgents.mockResolvedValue(undefined);
    agentIndexMock.computeAgentOptionsData.mockResolvedValue(options);

    await expect(loadRuntimeAgents()).resolves.toBeUndefined();
    await expect(computeRuntimeAgentOptionsData()).resolves.toBe(options);

    expect(agentIndexMock.loadAgents).toHaveBeenCalledOnce();
    expect(agentIndexMock.computeAgentOptionsData).toHaveBeenCalledOnce();
  });

  it('loads local catalogues and lists runtime agents by category', async () => {
    const visible = [{ name: 'proof', category: AgentCategory.ToolUse }];
    const all = [
      { name: 'proof', category: AgentCategory.ToolUse },
      { name: 'hidden', category: AgentCategory.ToolUse, internal: true },
    ];
    agentIndexMock.loadAgents.mockResolvedValue(undefined);
    agentIndexMock.getVisibleAgents.mockReturnValue(visible);
    agentIndexMock.getAgentsByCategory.mockReturnValue(all);

    await expect(
      loadRuntimeAgents({ includeRemote: false }),
    ).resolves.toBeUndefined();
    expect(
      listRuntimeAgents({
        category: AgentCategory.ToolUse,
        visibleOnly: true,
      }),
    ).toBe(visible);
    expect(listRuntimeAgents({ category: AgentCategory.ToolUse })).toBe(all);

    expect(agentIndexMock.loadAgents).toHaveBeenCalledWith({
      includeRemote: false,
    });
    expect(agentIndexMock.getVisibleAgents).toHaveBeenCalledWith(
      AgentCategory.ToolUse,
    );
    expect(agentIndexMock.getAgentsByCategory).toHaveBeenCalledWith(
      AgentCategory.ToolUse,
    );
  });

  it('projects remote agent profile records through the runtime boundary', () => {
    const remote = {
      name: 'cloud-proof',
      category: AgentCategory.ToolUse,
      source: 'remote',
    };
    const profile = {
      name: 'cloud-proof',
      description: '',
      visibility: ['public'],
      category: AgentCategory.ToolUse,
      supportsMultipleOutput: false,
    };
    agentIndexMock.getAgentsBySource.mockReturnValue([remote]);
    agentIndexMock.toRemoteAgentProfileData.mockReturnValue(profile);

    expect(listRuntimeRemoteAgentProfiles()).toEqual([profile]);

    expect(agentIndexMock.getAgentsBySource).toHaveBeenCalledWith('remote');
    expect(agentIndexMock.toRemoteAgentProfileData.mock.calls[0]?.[0]).toBe(
      remote,
    );
  });

  it('inspects local agent definitions as one runtime transaction', async () => {
    const resolution = {
      definitionPath: '/agents/proof.yaml',
      entry: {
        name: 'proof',
        category: AgentCategory.Workflow,
        source: 'builtInWorkflow',
      },
      resolvedName: 'proof',
    };
    const settings = { model: 'test-model' };
    const prompts = { systemPrompt: 'Check the proof.' };
    const rawDefinition = {
      name: 'proof',
      inherits: 'base-proof',
      settings: {},
      prompts: {},
    };
    agentLaunchContextMock.getAgentPath.mockResolvedValue(resolution);
    agentLoadMock.loadAgentDefinitionInspectionData.mockResolvedValue({
      rawDefinition,
      inheritedAgentName: 'base-proof',
      settings,
      prompts,
    });

    await expect(
      inspectRuntimeAgentDefinition('proof', {} as never),
    ).resolves.toEqual({
      resolution,
      rawDefinition,
      inheritedAgentName: 'base-proof',
      settings,
      prompts,
    });

    expect(agentLaunchContextMock.getAgentPath).toHaveBeenCalledWith(
      'proof',
      {},
      AgentCategory.Workflow,
      undefined,
    );
    expect(
      agentLoadMock.loadAgentDefinitionInspectionData,
    ).toHaveBeenCalledWith(resolution);
  });

  it('inspects remote agents without local YAML loading', async () => {
    const resolution = {
      definitionPath: 'remote:proof',
      entry: {
        name: 'proof',
        category: AgentCategory.ToolUse,
        source: 'remote',
      },
      resolvedName: 'proof',
    };
    const settings = { agentCategory: AgentCategory.ToolUse };
    const prompts = { systemPrompt: 'Remote proof.' };
    agentLaunchContextMock.getAgentPath.mockResolvedValue(resolution);
    agentLoadMock.loadAgentDefinitionInspectionData.mockResolvedValue({
      settings,
      prompts,
    });

    await expect(
      inspectRuntimeAgentDefinition(
        'remote:proof',
        {} as never,
        AgentCategory.ToolUse,
      ),
    ).resolves.toEqual({
      resolution,
      settings,
      prompts,
    });
    expect(
      agentLoadMock.loadAgentDefinitionInspectionData,
    ).toHaveBeenCalledWith(resolution);
  });

  it('refreshes the runtime agent catalog', async () => {
    agentIndexMock.refresh.mockResolvedValue(undefined);

    await expect(refreshRuntimeAgentCatalog()).resolves.toBeUndefined();

    expect(agentIndexMock.refresh).toHaveBeenCalledOnce();
  });
});
