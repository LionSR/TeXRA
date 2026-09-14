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
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import { fakeStores } from '@test/support/FakePlatform';
import { AbsoluteFS } from '@utils/files/absoluteFS';

const mocks = vi.hoisted(() => ({
  helperModel: vi.fn(),
  helperCompletion: vi.fn(),
  validateAgentYamlContent: vi.fn(),
}));

vi.mock('@agent/runtime/helperModel', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/helperModel')>()),
  helperModel: mocks.helperModel,
  helperCompletion: mocks.helperCompletion,
}));

vi.mock('@agent/runtime/agentLoad', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/agentLoad')>()),
  validateAgentYamlContent: mocks.validateAgentYamlContent,
}));

/**
 * The creator only forwards its stores to `helperModel`, which this suite
 * mocks, so empty stores are enough to exercise the orchestration.
 */
const STORES = fakeStores();

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
    mocks.helperModel.mockReset();
    mocks.helperCompletion.mockReset();
    mocks.validateAgentYamlContent.mockReset();
    mocks.helperModel.mockReturnValue(Effect.succeed({} as BoundModel));
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
    mocks.helperCompletion.mockImplementation(
      (
        _bound: unknown,
        options: {
          userPrompt: string;
          systemPrompt: string;
        },
      ) =>
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

    await Effect.runPromise(runAgentCreator(CONFIG, 'workflow', ui, STORES));

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

    await Effect.runPromise(runAgentCreator(CONFIG, 'workflow', ui, STORES));

    expect(mocks.helperCompletion).toHaveBeenCalledTimes(2);
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(mocks.helperCompletion.mock.calls[1]?.[1]).toEqual(
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

    await Effect.runPromise(runAgentCreator(CONFIG, 'workflow', ui, STORES));

    expect(mocks.helperModel).toHaveBeenCalledTimes(2);
    expect(mocks.helperCompletion).toHaveBeenCalledTimes(2);
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
