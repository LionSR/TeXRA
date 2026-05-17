// Standard library imports
import { strict as assert } from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { createPartFromText, type Content } from '@google/genai';
import { describe, it } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory, AgentSettingSchema } from '@agent/core/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/modelHandlerGoogleGenAI';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/modelHandlerOpenAI';
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/modelHandlerOpenRouterNative';

// Local imports - logger
import type { AgentLogger } from '@logger/AgentLogger';

// Local imports - utils
import type { FileLocation } from '@utils/files';

// Type imports
import type { ChatMessages } from '@openrouter/sdk/models';

type LoggerStub = Partial<AgentLogger> & {
  streamId: string;
};

function createLoggerStub(): LoggerStub {
  return {
    streamId: 'test-channel',
    debug: () => {
      /* no-op for tests */
    },
    info: () => {
      /* no-op for tests */
    },
    warn: () => {
      /* no-op for tests */
    },
    error: () => {
      /* no-op for tests */
    },
    withCurrentGroup: () => undefined,
    runWithinCurrentGroup: async (fn: () => any) => fn(),
    runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
  };
}

function buildConfig(
  provider: ModelProvider,
  overrides: Partial<ModelConfig> = {},
): ModelConfig {
  return {
    name: 'test-model',
    label: 'Test Model',
    fullName: 'test-model',
    shortName: 'test-model',
    provider,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsReasoning: false,
      supportsVision: false,
      ...(overrides.capabilities ?? {}),
    },
    openRouterOnly: false,
    ...overrides,
  };
}

function createAgentSetting() {
  return AgentSettingSchema.parse({
    agentCategory: AgentCategory.Workflow,
    documentTag: 'documents',
    endTag: '</documents>',
  });
}

async function withMissingOutput<T>(
  test: (outputLocation: FileLocation) => Promise<T>,
): Promise<T> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-prefill-'));
  try {
    return await test({
      kind: 'external',
      absolutePath: path.join(tempDir, 'r0', 'output.xml'),
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('model handler empty prefill behavior', () => {
  it('OpenAI chat preserves user content when prefill is empty', async () => {
    await withMissingOutput(async (outputLocation) => {
      const handler = new ModelHandlerOpenAI(buildConfig(ModelProvider.OPENAI));
      handler.setLogger(createLoggerStub() as unknown as AgentLogger);
      const messages = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'revise the document' }],
        },
      ];

      const [isComplete, updatedMessages] =
        await handler.initializeOutputAndPrefill(
          {} as AgentConfig,
          createAgentSetting(),
          messages,
          AgentWorkspaceState.create(),
          outputLocation,
          '',
        );

      assert.equal(isComplete, false);
      assert.deepEqual(updatedMessages, [
        {
          role: 'user',
          content: [{ type: 'text', text: 'revise the document' }],
        },
      ]);
    });
  });

  it('Google GenAI preserves user parts when prefill is empty', async () => {
    await withMissingOutput(async (outputLocation) => {
      const handler = new ModelHandlerGoogleGenAI(
        buildConfig(ModelProvider.GOOGLE),
      );
      handler.setLogger(createLoggerStub() as unknown as AgentLogger);
      const messages: Content[] = [
        {
          role: 'user',
          parts: [createPartFromText('revise the document')],
        },
      ];
      const workspaceState = AgentWorkspaceState.create();

      const [isComplete, updatedMessages] =
        await handler.initializeOutputAndPrefill(
          {} as AgentConfig,
          createAgentSetting(),
          messages,
          workspaceState,
          outputLocation,
          '',
        );

      assert.equal(isComplete, false);
      assert.deepEqual(updatedMessages, [
        {
          role: 'user',
          parts: [createPartFromText('revise the document')],
        },
      ]);
      assert.equal(workspaceState.assembly.accumulatedOutput, '');
    });
  });

  it('OpenRouter native preserves user content when prefill is empty', async () => {
    await withMissingOutput(async (outputLocation) => {
      const handler = new ModelHandlerOpenRouterNative(
        buildConfig(ModelProvider.OPENAI, {
          openrouterFullName: 'openai/test-model',
        }),
      );
      handler.setLogger(createLoggerStub() as unknown as AgentLogger);
      const messages: ChatMessages[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'revise the document' }],
        },
      ];

      const [isComplete, updatedMessages] =
        await handler.initializeOutputAndPrefill(
          {} as AgentConfig,
          createAgentSetting(),
          messages,
          AgentWorkspaceState.create(),
          outputLocation,
          '',
        );

      assert.equal(isComplete, false);
      assert.deepEqual(updatedMessages, [
        {
          role: 'user',
          content: [{ type: 'text', text: 'revise the document' }],
        },
      ]);
    });
  });
});
