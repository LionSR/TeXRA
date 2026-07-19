// Standard library imports
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { createPartFromText, type Content } from '@google/genai';
import { describe, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports - test support and agent
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { noopTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/google/modelHandlerGoogleGenAI';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative';

// Local imports - shared
import type { FileLocation } from '@shared/schemas';

// Type imports
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ChatMessages } from '@openrouter/sdk/models';

function createAgentSetting() {
  return AgentSettingSchema.parse({
    agentCategory: AgentCategory.Workflow,
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
      const handler = new ModelHandlerOpenAI(
        buildTestModelConfig({
          provider: ModelProvider.OPENAI,
          capabilities: { supportsReasoning: false, supportsVision: false },
        }),
      );
      handler.setLogger({ ...noopTrace });
      const messages: ChatCompletionMessageParam[] = [
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
        buildTestModelConfig({
          provider: ModelProvider.GOOGLE,
          capabilities: { supportsReasoning: false, supportsVision: false },
        }),
      );
      handler.setLogger({ ...noopTrace });
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
        buildTestModelConfig({
          provider: ModelProvider.OPENAI,
          capabilities: { supportsReasoning: false, supportsVision: false },
          openrouterFullName: 'openai/test-model',
        }),
      );
      handler.setLogger({ ...noopTrace });
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
