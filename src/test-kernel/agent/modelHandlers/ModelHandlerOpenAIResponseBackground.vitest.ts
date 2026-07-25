// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, afterEach, vi } from 'vitest';
import { type ModelConfig, ModelProvider } from 'llm-zoo';

// Local imports - agent
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { ModelHandlerCodex } from '@agent/modelHandlers/openai/modelHandlerCodex';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import * as configModule from '@utils/config/configUtils';

class UnsupportedBackgroundHandler extends ModelHandlerOpenAIResponse {
  protected override backgroundModeSupported = false;
}

function createOpenAIConfig(name: string): ModelConfig {
  return buildTestModelConfig({
    name,
    label: name,
    fullName: name,
    shortName: name,
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 10,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1000,
    openRouterOnly: false,
  });
}

describe('ModelHandlerOpenAIResponse background mode', () => {
  const originalGetConfig = configModule.getConfig;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enables background mode by default only for GPT workflow agents', () => {
    const handler = new ModelHandlerOpenAIResponse(createOpenAIConfig('gpt-5'));
    handler.setAgentCategory(AgentCategory.Workflow);

    assert.equal(handler.isBackgroundModeActive(), true);
    assert.equal(handler.getStreamingConfig(), false);
  });

  it('keeps GPT tool-use agents on streaming requests by default', () => {
    const handler = new ModelHandlerOpenAIResponse(createOpenAIConfig('gpt-5'));
    handler.setAgentCategory(AgentCategory.ToolUse);

    assert.equal(handler.isBackgroundModeActive(), false);
    assert.equal(handler.getStreamingConfig(), true);
  });

  it('keeps non-GPT workflow agents on streaming requests by default', () => {
    const handler = new ModelHandlerOpenAIResponse(createOpenAIConfig('o3'));
    handler.setAgentCategory(AgentCategory.Workflow);

    assert.equal(handler.isBackgroundModeActive(), false);
    assert.equal(handler.getStreamingConfig(), true);
  });

  it('respects the background-mode toggle for GPT workflow agents', () => {
    vi.spyOn(configModule, 'getConfig').mockImplementation(
      <T>(key: string, defaultValue?: T): T => {
        if (key === 'texra.model.useBackgroundResponses') {
          return false as T;
        }
        return originalGetConfig(key, defaultValue);
      },
    );

    const handler = new ModelHandlerOpenAIResponse(createOpenAIConfig('gpt-5'));
    handler.setAgentCategory(AgentCategory.Workflow);

    assert.equal(handler.isBackgroundModeActive(), false);
    assert.equal(handler.getStreamingConfig(), true);
  });

  it('keeps streaming enabled when an eligible handler cannot use background mode', () => {
    const handler = new UnsupportedBackgroundHandler(
      createOpenAIConfig('gpt-5'),
    );
    handler.setAgentCategory(AgentCategory.Workflow);

    assert.equal(handler.isBackgroundModeActive(), false);
    assert.equal(handler.getStreamingConfig(), true);
  });

  it('runs the Codex fallback (subscription off) path through the shared background toggle', () => {
    // With the subscription preference off (the default here — no platform
    // override sets it), ModelHandlerCodex drops to the base OpenAI-API-key
    // path, where background mode follows the shared useBackgroundResponses
    // toggle (default on) + workflow/GPT eligibility. The subscription-ON veto
    // (Codex backend can't poll) is covered in CodexExperimentalTransports.
    const handler = new ModelHandlerCodex(createOpenAIConfig('gpt-5'));
    handler.setAgentCategory(AgentCategory.Workflow);

    assert.equal(handler.isBackgroundModeActive(), true);
    assert.equal(handler.getStreamingConfig(), false);
  });

  it('keeps Codex tool-use agents on streaming requests by default', () => {
    const handler = new ModelHandlerCodex(createOpenAIConfig('gpt-5'));
    handler.setAgentCategory(AgentCategory.ToolUse);

    assert.equal(handler.isBackgroundModeActive(), false);
    assert.equal(handler.getStreamingConfig(), true);
  });

  it('reports Codex subscription usage without API-key spend', () => {
    const handler = new ModelHandlerCodex(createOpenAIConfig('gpt-5'));

    assert.equal(
      handler.computePrice({
        input_tokens: 10_000,
        output_tokens: 10_000,
      } as any),
      0,
    );
  });
});
