// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import { FinishReason } from '@google/genai';

// Local imports - agent
import type { AgentSetting } from '@agent/core/AgentDataclass';
import { ModelHandlerGoogle } from '@agent/modelHandlers/modelHandlerGoogle';
import { OPENAI_CHAT_FINISH } from '@agent/modelHandlers/types/StopReasonTypes';

// Local imports - model config
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from '@model/ModelConfig';

describe('ModelHandlerGoogle.shouldContinue', () => {
  const handler = new ModelHandlerGoogle({
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
    agentCategory: 'workflow',
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

  it('continues when the OpenAI-compatible length stop reason is returned', () => {
    const shouldContinue = handler.shouldContinue(
      OPENAI_CHAT_FINISH.LENGTH,
      'partial output',
      agentSetting,
    );

    assert.equal(shouldContinue, true);
  });

  it('continues when the stop reason is max_tokens in snake case', () => {
    const shouldContinue = handler.shouldContinue(
      'max_tokens',
      'partial output',
      agentSetting,
    );

    assert.equal(shouldContinue, true);
  });

  it('continues when the SDK reports maxTokens in camelCase', () => {
    const shouldContinue = handler.shouldContinue(
      'maxTokens',
      'partial output',
      agentSetting,
    );

    assert.equal(shouldContinue, true);
  });
});
