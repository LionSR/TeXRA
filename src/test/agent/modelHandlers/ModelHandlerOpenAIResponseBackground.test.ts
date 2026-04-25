// Node.js built-in imports
import { strict as assert } from 'assert';

// Third-party imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - agent
import { AgentCategory } from '@agent/core/AgentDataclass';
import * as configModule from '@agent/core/config';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';

class UnsupportedBackgroundHandler extends ModelHandlerOpenAIResponse {
  protected override backgroundModeSupported = false;
}

function createOpenAIConfig(name: string): ModelConfig {
  return {
    name,
    label: name,
    fullName: name,
    shortName: name,
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 10,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1000,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
  };
}

describe('ModelHandlerOpenAIResponse background mode', () => {
  const originalGetConfig = configModule.getConfig;

  afterEach(() => {
    (configModule as { getConfig: typeof originalGetConfig }).getConfig =
      originalGetConfig;
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
    (configModule as { getConfig: typeof originalGetConfig }).getConfig = (<T>(
      key: string,
      defaultValue?: T,
    ): T => {
      if (key === 'texra.model.useBackgroundResponses') {
        return false as T;
      }
      return originalGetConfig(key, defaultValue);
    }) as typeof originalGetConfig;

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
});
