// Node imports
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

// Third-party imports
import { openaiChatModel } from '@texra-ai/llm/openai-chat';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AgentCreatorUI,
  type CreatorConfig,
  runAgentCreator,
} from '@agent/implementations/agentCreator/agentCreatorFlow';
import { AbsoluteFS } from '@utils/files/absoluteFS';

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
    getCustomAgentDir: vi.fn(async () => resolve('/agents')),
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
  const fetchModel = vi.fn<typeof fetch>();

  function generatedResponse(text: string): Response {
    const chunk = {
      id: 'synthetic-agent-yaml',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'configured-helper',
      choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  beforeEach(() => {
    mocks.createHelperModelKit.mockReset();
    mocks.runHelperModelCompletion.mockReset();
    mocks.validateAgentYamlContent.mockReset();
    mocks.createHelperModelKit.mockResolvedValue({
      kit: { handler: {}, client: {} },
    });
    fetchModel
      .mockReset()
      .mockImplementation(async () =>
        generatedResponse('<yaml>generated: true</yaml>'),
      );
    const model = openaiChatModel(
      {
        protocol: 'openai-chat',
        requestedModel: 'configured-helper',
        supportsTemperature: true,
        supportedEfforts: [],
        deployment: {
          endpoint: 'https://synthetic.invalid/v1',
          credentialScope: 'synthetic-agent-creator',
        },
        defaults: {
          temperature: 0,
          effort: null,
          maxOutputTokens: 4096,
          parallelToolCalls: true,
        },
      },
      { apiKey: 'synthetic', fetch: fetchModel },
    );
    // Development proof only: the production helper's configured routes remain unchanged.
    mocks.runHelperModelCompletion.mockImplementation(
      (
        _kit: unknown,
        options: {
          userPrompt: string;
          systemPrompt: string;
          signal?: AbortSignal;
        },
      ) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const turn = yield* model.prepareTurn({
              system: options.systemPrompt,
              messages: [
                {
                  role: 'user',
                  content: [{ kind: 'text', text: options.userPrompt }],
                },
              ],
            });
            assert(turn.mode === 'foreground');
            const result = yield* model.generateTurn(turn);
            return result.content
              .flatMap((part) => (part.kind === 'message' ? part.content : []))
              .filter((part) => part.kind === 'text')
              .map((part) => part.text)
              .join('');
          }),
          { signal: options.signal },
        ),
    );
    mocks.validateAgentYamlContent.mockImplementation(() => undefined);
    vi.spyOn(AbsoluteFS, 'write').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a workflow agent and preserves registration side-effect order', async () => {
    const events: string[] = [];
    const ui = createUi(events);
    vi.mocked(AbsoluteFS.write).mockImplementation(async () => {
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
      resolve('/agents/editor.yaml'),
      'generated: true',
    );
    expect(ui.promptAddToConfig).toHaveBeenCalledWith('editor', 'workflow');
    expect(ui.openCreatedFile).toHaveBeenCalledWith(
      resolve('/agents/editor.yaml'),
    );
    expect(events.indexOf('write')).toBeLessThan(events.indexOf('register'));
  });

  it('passes selected tool metadata into tool-use generation', async () => {
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
    expect(ui.promptAddToConfig).toHaveBeenCalledWith('researcher', 'toolUse');
  });

  it('stops before description when name selection is cancelled', async () => {
    const ui = createUi([], {
      promptAgentName: vi.fn(async () => undefined),
    });

    await runAgentCreator(CONFIG, 'workflow', ui);

    expect(ui.promptDescription).not.toHaveBeenCalled();
    expect(mocks.createHelperModelKit).not.toHaveBeenCalled();
    expect(AbsoluteFS.write).not.toHaveBeenCalled();
  });

  it('stops before generation when description is cancelled', async () => {
    const ui = createUi([], {
      promptDescription: vi.fn(async () => undefined),
    });

    await runAgentCreator(CONFIG, 'workflow', ui);

    expect(ui.getCustomAgentDir).not.toHaveBeenCalled();
    expect(mocks.createHelperModelKit).not.toHaveBeenCalled();
    expect(AbsoluteFS.write).not.toHaveBeenCalled();
  });

  it('stops tool-use creation before filesystem access when tool selection is cancelled', async () => {
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
    const ui = createUi();
    fetchModel
      .mockImplementationOnce(async () =>
        generatedResponse('<yaml>invalid</yaml>'),
      )
      .mockImplementationOnce(async () =>
        generatedResponse('<yaml>valid: true</yaml>'),
      );
    mocks.validateAgentYamlContent
      .mockImplementationOnce(() => {
        throw new Error('missing prompts');
      })
      .mockImplementationOnce(() => undefined);

    await runAgentCreator(CONFIG, 'workflow', ui);

    expect(mocks.runHelperModelCompletion).toHaveBeenCalledTimes(2);
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(mocks.runHelperModelCompletion.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        userPrompt: expect.stringContaining('Retry workflow: missing prompts'),
      }),
    );
    expect(AbsoluteFS.write).toHaveBeenCalledWith(
      resolve('/agents/editor.yaml'),
      'valid: true',
    );
  });

  it('uses the deterministic template after both generation attempts fail', async () => {
    const ui = createUi();
    fetchModel.mockRejectedValue(
      new TypeError('synthetic network unavailable'),
    );

    await runAgentCreator(CONFIG, 'workflow', ui);

    expect(mocks.createHelperModelKit).toHaveBeenCalledTimes(2);
    expect(mocks.runHelperModelCompletion).toHaveBeenCalledTimes(2);
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(ui.renderTemplate).toHaveBeenCalledWith('workflow fallback', {
      AGENT_NAME: 'editor',
      DESCRIPTION: 'Edit documents',
    });
    expect(AbsoluteFS.write).toHaveBeenCalledWith(
      resolve('/agents/editor.yaml'),
      'fallback yaml',
    );
  });
});
