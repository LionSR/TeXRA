// Node imports
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { openaiChatModel } from '@texra-ai/llm/openai-chat';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  type AgentCreatorUI,
  type CreatorConfig,
  runAgentCreator,
} from '@agent/implementations/agentCreator/agentCreatorFlow';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import { fakeStores } from '@test/support/FakePlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';

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
 * The creator only forwards its stores and setting slots to `helperModel`,
 * which this suite mocks, so empty ones are enough to exercise the
 * orchestration.
 */
const STORES = fakeStores();
const ROOTS = makeFakeSettingsStores().stores;

const CONFIG: CreatorConfig = {
  workflow: {
    systemPrompt: 'Create {{ AGENT_NAME }} for {{ DESCRIPTION }}.',
    userRequest: 'Generate workflow {{ AGENT_NAME }}.',
  },
  toolUse: {
    systemPrompt: 'Create {{ AGENT_NAME }} for {{ DESCRIPTION }}.',
    userRequest: 'Tools={{ SELECTED_TOOLS }}; Groups={{ SELECTED_GROUPS }}.',
  },
  retryPrompt: 'Retry: {{ VALIDATION_ERROR }}',
  templates: {
    workflowSingle: 'workflow fallback',
    toolUse: 'tool-use fallback',
  },
};

/**
 * The custom agent directory the creator writes into. The YAML write is a
 * real one on the process filesystem, so the suite gives it a real directory
 * and reads the file back instead of asserting on a mocked facade.
 */
let agentDir: string;
const agentPath = (): string => join(agentDir, 'editor.yaml');

/** The creator program with the `FileSystem` its YAML write requires. */
const createAgent = (ui: AgentCreatorUI): Effect.Effect<void, unknown> =>
  runAgentCreator(CONFIG, 'workflow', ui, STORES, ROOTS).pipe(
    Effect.provide(Layer.mergeAll(nodePlatformLayer, testHttpClientLayer)),
  );

function createUi(
  events: string[] = [],
  overrides: Partial<AgentCreatorUI> = {},
): AgentCreatorUI {
  return {
    promptAgentName: vi.fn(() => Effect.succeed('editor')),
    promptDescription: vi.fn(() => Effect.succeed('Edit documents')),
    pickTools: vi.fn(() =>
      Effect.succeed({ tools: ['edit_file'], groups: [] }),
    ),
    getCustomAgentDir: vi.fn(() => Effect.succeed(agentDir)),
    showCreatedInfo: vi.fn(() => events.push('show')),
    promptAddToConfig: vi.fn(() =>
      Effect.sync(() => {
        // The definition must already be on disk when it is registered.
        events.push(existsSync(agentPath()) ? 'written' : 'not-written');
        events.push('register');
      }),
    ),
    openCreatedFile: vi.fn(() =>
      Effect.sync(() => {
        events.push('open');
      }),
    ),
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

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'texra-agent-creator-'));
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(agentDir, { recursive: true, force: true });
  });

  it.live(
    'creates a workflow agent and preserves registration side-effect order',
    () =>
      Effect.gen(function* () {
        const events: string[] = [];
        const ui = createUi(events);

        yield* createAgent(ui);

        expect(ui.promptAgentName).toHaveBeenCalledWith('Workflow');
        expect(ui.promptDescription).toHaveBeenCalledWith(
          'New Workflow Agent: editor',
          expect.stringContaining('What should this agent do?'),
        );
        expect(ui.pickTools).not.toHaveBeenCalled();
        expect(readFileSync(agentPath(), 'utf8')).toBe('generated: true');
        expect(ui.promptAddToConfig).toHaveBeenCalledWith('editor', 'workflow');
        expect(ui.openCreatedFile).toHaveBeenCalledWith(agentPath());
        expect(events).toContain('written');
        expect(events.indexOf('written')).toBeLessThan(
          events.indexOf('register'),
        );
      }),
  );

  it.live(
    'includes the validation error in the second generation attempt',
    () =>
      Effect.gen(function* () {
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

        yield* createAgent(ui);

        expect(mocks.helperCompletion).toHaveBeenCalledTimes(2);
        expect(fetchModel).toHaveBeenCalledTimes(2);
        expect(mocks.helperCompletion.mock.calls[1]?.[1]).toEqual(
          expect.objectContaining({
            userPrompt: expect.stringContaining('Retry: missing prompts'),
          }),
        );
        expect(readFileSync(agentPath(), 'utf8')).toBe('valid: true');
      }),
  );

  it.live(
    'uses the deterministic template after both generation attempts fail',
    () =>
      Effect.gen(function* () {
        const ui = createUi();
        fetchModel.mockRejectedValue(
          new TypeError('synthetic network unavailable'),
        );

        yield* createAgent(ui);

        expect(mocks.helperModel).toHaveBeenCalledTimes(2);
        expect(mocks.helperCompletion).toHaveBeenCalledTimes(2);
        expect(fetchModel).toHaveBeenCalledTimes(2);
        expect(ui.renderTemplate).toHaveBeenCalledWith('workflow fallback', {
          AGENT_NAME: 'editor',
          DESCRIPTION: 'Edit documents',
        });
        expect(readFileSync(agentPath(), 'utf8')).toBe('fallback yaml');
      }),
  );
});
