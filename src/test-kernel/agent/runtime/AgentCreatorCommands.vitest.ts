import { describe, expect, it, vi } from 'vitest';

import {
  getRuntimeAgentCreatorToolGroupOptions,
  resolveRuntimeAgentCreatorToolGroups,
  runRuntimeAgentCreator,
  type RuntimeAgentCreatorConfig,
  type RuntimeAgentCreatorUI,
} from '@agent/runtime/agentCreatorCommands';

function createConfig(): RuntimeAgentCreatorConfig {
  return {
    workflow: {
      systemPrompt: '',
      userRequest: '',
    },
    toolUse: {
      systemPrompt: '',
      userRequest: '',
    },
    retryPrompts: {
      workflow: '',
      toolUse: '',
    },
    templates: {
      workflowSingle: '',
      toolUse: '',
    },
  };
}

function createCancellingUi(): RuntimeAgentCreatorUI {
  return {
    promptAgentName: vi.fn().mockResolvedValue(undefined),
    promptDescription: vi.fn(),
    pickTools: vi.fn(),
    getCustomAgentDir: vi.fn(),
    showCreatedInfo: vi.fn(),
    promptAddToConfig: vi.fn(),
    openCreatedFile: vi.fn(),
    renderTemplate: vi.fn(),
  };
}

describe('runtime agent-creator commands', () => {
  it('projects suggested tool groups from an agent description', () => {
    const options = getRuntimeAgentCreatorToolGroupOptions(
      'Search papers, inspect arXiv, and edit LaTeX files.',
    );
    const picked = options
      .filter((option) => option.picked)
      .map((option) => option.label);

    expect(picked).toEqual(
      expect.arrayContaining([
        'File Operations',
        'Web & Search',
        'Academic Research',
        'LaTeX Processing',
      ]),
    );
    expect(options[0]).toEqual(
      expect.objectContaining({
        label: expect.any(String),
        description: expect.any(String),
        detail: expect.any(String),
        picked: expect.any(Boolean),
      }),
    );
  });

  it('resolves selected tool groups to flow tool names', () => {
    expect(
      resolveRuntimeAgentCreatorToolGroups([
        'File Operations',
        'Computation',
        'Unknown Group',
      ]),
    ).toEqual({
      groups: ['File Operations', 'Computation'],
      tools: [
        'bash',
        'read_file',
        'write_file',
        'edit_file',
        'glob',
        'grep',
        'ls',
        'wolfram',
      ],
    });
  });

  it('runs the runtime-owned flow with host-provided UI callbacks', async () => {
    const ui = createCancellingUi();

    await expect(
      runRuntimeAgentCreator({
        ui,
        config: createConfig(),
        category: 'workflow',
      }),
    ).resolves.toBeUndefined();

    expect(ui.promptAgentName).toHaveBeenCalledWith('Workflow');
  });
});
