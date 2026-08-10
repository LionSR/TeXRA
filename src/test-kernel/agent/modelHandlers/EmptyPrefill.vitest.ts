// Node imports
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { describe, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports
import { noopTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import type { FileLocation } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

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

/** With no output file, the handler must pass the user messages through untouched. */
async function expectPrefillPreserved<M extends ProviderMessage>(
  handler: ModelHandler<M>,
  messages: M[],
  outputLocation: FileLocation,
): Promise<void> {
  handler.setLogger({ ...noopTrace });
  const workspaceState = AgentWorkspaceState.create();

  const [isComplete, updatedMessages] =
    await handler.initializeOutputAndPrefill(
      {} as AgentConfig,
      createAgentSetting(),
      messages,
      workspaceState,
      outputLocation,
    );

  assert.equal(isComplete, false);
  assert.deepEqual(updatedMessages, messages);
  assert.equal(workspaceState.assembly.accumulatedOutput, '');
}

describe('model handler output initialization with no output file', () => {
  it('OpenAI chat preserves user content when no output file exists', async () => {
    await withMissingOutput(async (outputLocation) => {
      const handler = new ModelHandlerOpenAI(
        buildTestModelConfig({
          provider: ModelProvider.OPENAI,
          capabilities: { supportsReasoning: false, supportsVision: false },
        }),
      );

      await expectPrefillPreserved(
        handler,
        [
          {
            role: 'user',
            content: [{ type: 'text', text: 'revise the document' }],
          },
        ],
        outputLocation,
      );
    });
  });

  it('Google Interactions preserves user content when no output file exists', async () => {
    await withMissingOutput(async (outputLocation) => {
      const handler = new ModelHandlerGoogleInteractions(
        buildTestModelConfig({
          provider: ModelProvider.GOOGLE,
          capabilities: { supportsReasoning: false, supportsVision: false },
        }),
      );

      await expectPrefillPreserved(
        handler,
        [
          {
            type: 'user_input',
            content: [{ type: 'text', text: 'revise the document' }],
          },
        ],
        outputLocation,
      );
    });
  });

  it('OpenRouter native preserves user content when no output file exists', async () => {
    await withMissingOutput(async (outputLocation) => {
      const handler = new ModelHandlerOpenRouterNative(
        buildTestModelConfig({
          provider: ModelProvider.OPENAI,
          capabilities: { supportsReasoning: false, supportsVision: false },
          openrouterFullName: 'openai/test-model',
        }),
      );

      await expectPrefillPreserved(
        handler,
        [
          {
            role: 'user',
            content: [{ type: 'text', text: 'revise the document' }],
          },
        ],
        outputLocation,
      );
    });
  });
});
