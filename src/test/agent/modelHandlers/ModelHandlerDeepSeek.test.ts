// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - agent
import { ModelHandlerDeepSeek } from '@agent/modelHandlers/modelHandlerDeepSeek';

function thinkingFor(
  fullName: string,
  supportsReasoning: boolean,
): { type: 'enabled' | 'disabled' } | undefined {
  const handler = new ModelHandlerDeepSeek({
    fullName,
    provider: ModelProvider.DEEPSEEK,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES, supportsReasoning },
  } as ModelConfig);
  return (handler as any).getThinkingParameter();
}

describe('ModelHandlerDeepSeek.getThinkingParameter', () => {
  it('deepseek-chat defaults OFF: omits param when reasoning disabled', () => {
    assert.equal(thinkingFor('deepseek-chat', false), undefined);
  });

  it('deepseek-chat defaults OFF: enables explicitly when reasoning requested', () => {
    assert.deepEqual(thinkingFor('deepseek-chat', true), { type: 'enabled' });
  });

  it('deepseek-reasoner defaults ON: omits param when reasoning requested', () => {
    assert.equal(thinkingFor('deepseek-reasoner', true), undefined);
  });

  it('deepseek-reasoner defaults ON: disables explicitly when reasoning off', () => {
    assert.deepEqual(thinkingFor('deepseek-reasoner', false), {
      type: 'disabled',
    });
  });

  it('deepseek-v4-flash defaults ON: omits param when reasoning requested', () => {
    assert.equal(thinkingFor('deepseek-v4-flash', true), undefined);
  });

  it('deepseek-v4-flash defaults ON: disables explicitly when reasoning off', () => {
    assert.deepEqual(thinkingFor('deepseek-v4-flash', false), {
      type: 'disabled',
    });
  });

  it('deepseek-v4-pro defaults ON: omits param when reasoning requested', () => {
    assert.equal(thinkingFor('deepseek-v4-pro', true), undefined);
  });

  it('deepseek-v4-pro defaults ON: disables explicitly when reasoning off', () => {
    assert.deepEqual(thinkingFor('deepseek-v4-pro', false), {
      type: 'disabled',
    });
  });

  it('unlisted fullName is treated as default-ON (matches V4+ convention)', () => {
    // Update getThinkingParameter if a new non-thinking model is added.
    assert.equal(thinkingFor('deepseek-future', true), undefined);
    assert.deepEqual(thinkingFor('deepseek-future', false), {
      type: 'disabled',
    });
  });
});
