// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import { FinishReason } from '@google/genai';

// Local imports - agent
import type { AgentSetting } from '@agent/core/AgentDataclass';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/modelHandlerGoogleGenAI';

// Local imports - model config
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from '@model/ModelConfig';

describe('ModelHandlerGoogleGenAI.shouldContinue', () => {
  const handler = new ModelHandlerGoogleGenAI({
    name: 'test-google-model',
    fullName: 'google/test',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 4096,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
  });

  const agentSetting = {
    endTag: '</doc>',
    documentTag: 'doc',
  } as AgentSetting;

  it('continues when FinishReason.MAX_TOKENS is returned without the end tag', () => {
    const shouldContinue = handler.shouldContinue(
      FinishReason.MAX_TOKENS,
      'partial output',
      agentSetting,
    );

    assert.equal(shouldContinue, true);
  });

  it('stops when the end tag is present even if FinishReason.MAX_TOKENS was returned', () => {
    const shouldContinue = handler.shouldContinue(
      FinishReason.MAX_TOKENS,
      'partial output</doc>',
      agentSetting,
    );

    assert.equal(shouldContinue, false);
  });

  it('does not continue when stop reason indicates a normal stop', () => {
    const shouldContinue = handler.shouldContinue(
      FinishReason.STOP,
      'partial output',
      agentSetting,
    );

    assert.equal(shouldContinue, false);
  });
});
