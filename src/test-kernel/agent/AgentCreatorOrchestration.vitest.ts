import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AgentCreatorUI,
  type CreatorConfig,
  runAgentCreator,
} from '@agent/implementations/flows/agentCreator/agentCreatorFlow';
import { AbsoluteFS } from '@utils/files';

const mocks = vi.hoisted(() => ({
  createHelperModelKit: vi.fn(),
  runHelperModelCompletion: vi.fn(),
  validateAgentYamlContent: vi.fn(),
}));

vi.mock('@agent/runtime/helperModel', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/helperModel')>()),
  createHelperModelKit: mocks.createHelperModelKit,
  runHelperModelCompletion: mocks.runHelperModelCompletion,
}));

vi.mock('@agent/runtime/agentLoad', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/agentLoad')>()),
  validateAgentYamlContent: mocks.validateAgentYamlContent,
}));

const CONFIG: CreatorConfig = {
  workflow: {
    systemPrompt: 'Create {{ AGENT_NAME }} for {{ DESCRIPTION }}.',
    userRequest: 'Generate workflow {{ AGENT_NAME }}.',
  },
  toolUse: {
    systemPrompt: 'Create {{ AGENT_NAME }} for {{ DESCRIPTION }}.',
    userRequest: 'Tools={{ SELECTED_TOOLS }}; Groups={{ SELECTED_GROUPS }}.',
  },
  retryPrompts: {
    workflow: 'Retry workflow: {{ VALIDATION_ERROR }}',
    toolUse: 'Retry tool use: {{ VALIDATION_ERROR }}',
  },
  templates: {
    workflowSingle: 'workflow fallback',
    toolUse: 'tool-use fallback',
  },
};

function createUi(
  events: string[] = [],
  overrides: Partial<AgentCreatorUI> = {},
): AgentCreatorUI {
  return {
    promptAgentName: vi.fn(async () => 'editor'),
    promptDescription: vi.fn(async () => 'Edit documents'),
    pickTools: vi.fn(async () => ({ tools: ['edit_file'], groups: [] })),
    getCustomAgentDir: vi.fn(async () => '/agents'),
    showCreatedInfo: vi.fn(() => events.push('show')),
    promptAddToConfig: vi.fn(async () => {
      events.push('register');
    }),
    openCreatedFile: vi.fn(async () => {
      events.push('open');
    }),
    renderTemplate: vi.fn(() => 'fallback yaml'),
    ...overrides,
  };
}

describe('agent creator orchestration', () => {
  beforeEach(() => {
    mocks.createHelperModelKit.mockReset();
    mocks.runHelperModelCompletion.mockReset();
    mocks.validateAgentYamlContent.mockReset();
    mocks.createHelperModelKit.mockResolvedValue({
      kit: { modelName: 'test' },
    });
    mocks.runHelperModelCompletion.mockResolvedValue(
      '<yaml>generated: true</yaml>',
    );
    mocks.validateAgentYamlContent.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a workflow agent and preserves registration side-effect order', async () => {
    const events: string[] = [];
    const ui = createUi(events);
    vi.spyOn(AbsoluteFS, 'write').mockImplementation(async () => {
      events.push('write');
    });

    await runAgentCreator(CONFIG, 'workflow', ui);

    expect(ui.promptAgentName).toHaveBeenCalledWith('Workflow');
    expect(ui.promptDescription).toHaveBeenCalledWith(
      'New Workflow Agent: editor',
      expect.stringContaining('What should this agent do?'),
    );
    expect(ui.pickTools).not.toHaveBeenCalled();
    expect(AbsoluteFS.write).toHaveBeenCalledWith(
      '/agents/editor.yaml',
      'generated: true',
    );
    expect(ui.promptAddToConfig).toHaveBeenCalledWith(
      'editor',
      false,
      'workflow',
    );
    expect(ui.openCreatedFile).toHaveBeenCalledWith('/agents/editor.yaml');
    expect(events).toEqual(['write', 'show', 'register', 'open']);
  });

  it('passes selected tool metadata into tool-use generation', async () => {
    vi.spyOn(AbsoluteFS, 'write').mockResolvedValue(undefined);
    const ui = createUi([], {
      promptAgentName: vi.fn(async () => 'researcher'),
      promptDescription: vi.fn(async () => 'Search papers and edit files'),
      pickTools: vi.fn(async () => ({
        tools: ['web_search', 'write_file'],
        groups: ['Web & Search', 'File Operations'],
      })),
    });

    await runAgentCreator(CONFIG, 'toolUse', ui);

    expect(ui.pickTools).toHaveBeenCalledWith(
      'researcher',
      'Search papers and edit files',
      expect.arrayContaining([
        'File Operations',
        'Web & Search',
        'Academic Research',
      ]),
    );
    expect(mocks.runHelperModelCompletion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userPrompt:
          'Tools=web_search, write_file; Groups=Web & Search, File Operations.',
        systemPrompt: expect.stringContaining(
          'Create researcher for Search papers and edit files.',
        ),
      }),
    );
    expect(ui.promptAddToConfig).toHaveBeenCalledWith(
      'researcher',
      false,
      'toolUse',
    );
  });

  it('stops before description when name selection is cancelled', async () => {
    vi.spyOn(AbsoluteFS, 'write').mockResolvedValue(undefined);
    const ui = createUi([], {
      promptAgentName: vi.fn(async () => undefined),
    });

    await runAgentCreator(CONFIG, 'workflow', ui);

    expect(ui.promptDescription).not.toHaveBeenCalled();
    expect(mocks.createHelperModelKit).not.toHaveBeenCalled();
    expect(AbsoluteFS.write).not.toHaveBeenCalled();
  });

  it('stops before generation when description is cancelled', async () => {
    vi.spyOn(AbsoluteFS, 'write').mockResolvedValue(undefined);
    const ui = createUi([], {
      promptDescription: vi.fn(async () => undefined),
    });

    await runAgentCreator(CONFIG, 'workflow', ui);

    expect(ui.getCustomAgentDir).not.toHaveBeenCalled();
    expect(mocks.createHelperModelKit).not.toHaveBeenCalled();
    expect(AbsoluteFS.write).not.toHaveBeenCalled();
  });

  it('stops tool-use creation before filesystem access when tool selection is cancelled', async () => {
    vi.spyOn(AbsoluteFS, 'write').mockResolvedValue(undefined);
    const ui = createUi([], {
      pickTools: vi.fn(async () => undefined),
    });

    await runAgentCreator(CONFIG, 'toolUse', ui);

    expect(ui.getCustomAgentDir).not.toHaveBeenCalled();
    expect(mocks.createHelperModelKit).not.toHaveBeenCalled();
    expect(AbsoluteFS.write).not.toHaveBeenCalled();
    expect(ui.promptAddToConfig).not.toHaveBeenCalled();
  });

  it('includes the validation error in the second generation attempt', async () => {
    vi.spyOn(AbsoluteFS, 'write').mockResolvedValue(undefined);
    const ui = createUi();
    mocks.runHelperModelCompletion
      .mockResolvedValueOnce('<yaml>invalid</yaml>')
      .mockResolvedValueOnce('<yaml>valid: true</yaml>');
    mocks.validateAgentYamlContent
      .mockImplementationOnce(() => {
        throw new Error('missing prompts');
      })
      .mockImplementationOnce(() => undefined);

    await runAgentCreator(CONFIG, 'workflow', ui);

    expect(mocks.runHelperModelCompletion).toHaveBeenCalledTimes(2);
    expect(mocks.runHelperModelCompletion.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        userPrompt: expect.stringContaining('Retry workflow: missing prompts'),
      }),
    );
    expect(AbsoluteFS.write).toHaveBeenCalledWith(
      '/agents/editor.yaml',
      'valid: true',
    );
  });

  it('uses the deterministic template after both generation attempts fail', async () => {
    vi.spyOn(AbsoluteFS, 'write').mockResolvedValue(undefined);
    const ui = createUi();
    mocks.runHelperModelCompletion.mockRejectedValue(
      new Error('model unavailable'),
    );

    await runAgentCreator(CONFIG, 'workflow', ui);

    expect(mocks.createHelperModelKit).toHaveBeenCalledTimes(2);
    expect(mocks.runHelperModelCompletion).toHaveBeenCalledTimes(2);
    expect(ui.renderTemplate).toHaveBeenCalledWith('workflow fallback', {
      AGENT_NAME: 'editor',
      DESCRIPTION: 'Edit documents',
    });
    expect(AbsoluteFS.write).toHaveBeenCalledWith(
      '/agents/editor.yaml',
      'fallback yaml',
    );
  });
});
