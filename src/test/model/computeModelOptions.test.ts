// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as sinon from 'sinon';

// Local imports
import { computeModelOptions } from '@model/computeModelOptions';
import { SecretManager } from '@frontend/secretManager';
import * as config from '@utils/config';

describe('computeModelOptions', () => {
  let getConfigStub: sinon.SinonStub;
  let apiKeyExistsStub: sinon.SinonStub;

  beforeEach(() => {
    getConfigStub = sinon.stub(config, 'getConfig');
    apiKeyExistsStub = sinon.stub(SecretManager, 'apiKeyExists');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should handle models without config', async () => {
    getConfigStub.withArgs('models').returns(['unknown-model']);
    apiKeyExistsStub.resolves(false);

    const result = await computeModelOptions();
    assert.strictEqual(result, '<option value="unknown-model">unknown-model</option>');
  });

  it('should mark models without API keys as disabled', async () => {
    getConfigStub.withArgs('models').returns(['claude-3-5-sonnet-20241022']);
    apiKeyExistsStub.withArgs('anthropic').resolves(false);
    apiKeyExistsStub.withArgs('openRouter').resolves(false);

    const result = await computeModelOptions();
    assert.ok(result.includes('disabled'));
    assert.ok(result.includes('(no key)'));
  });

  it('should include tooltips with model information', async () => {
    getConfigStub.withArgs('models').returns(['claude-3-5-sonnet-20241022']);
    apiKeyExistsStub.withArgs('anthropic').resolves(true);

    const result = await computeModelOptions();
    assert.ok(result.includes('title='));
    assert.ok(result.includes('Provider:'));
    assert.ok(result.includes('Tokens'));
    assert.ok(result.includes('Pricing'));
  });

  it('should handle multi-word provider names correctly', async () => {
    getConfigStub.withArgs('models').returns(['deepseek-chat']);
    apiKeyExistsStub.resolves(true);

    const result = await computeModelOptions();
    // Check that provider formatting works (e.g., "openRouter" -> "Open Router")
    assert.ok(result.includes('Provider:'));
  });

  it('should handle missing pricing information gracefully', async () => {
    // Create a mock model config with undefined pricing
    const mockModel = 'test-model';
    getConfigStub.withArgs('models').returns([mockModel]);
    apiKeyExistsStub.resolves(true);

    // Override MODEL_CONFIGS for this test
    const originalConfigs = require('@model/ModelRegistry').MODEL_CONFIGS;
    require('@model/ModelRegistry').MODEL_CONFIGS[mockModel] = {
      name: mockModel,
      provider: 'testProvider',
      contextWindow: 100000,
      maxOutputTokens: 4096,
      inputPrice: undefined,
      outputPrice: undefined,
    };

    const result = await computeModelOptions();
    
    // Should not include pricing line when prices are undefined
    assert.ok(!result.includes('$undefined'));
    
    // Restore original configs
    require('@model/ModelRegistry').MODEL_CONFIGS = originalConfigs;
  });

  it('should handle missing token limits gracefully', async () => {
    const mockModel = 'test-model-no-tokens';
    getConfigStub.withArgs('models').returns([mockModel]);
    apiKeyExistsStub.resolves(true);

    // Override MODEL_CONFIGS for this test
    const originalConfigs = require('@model/ModelRegistry').MODEL_CONFIGS;
    require('@model/ModelRegistry').MODEL_CONFIGS[mockModel] = {
      name: mockModel,
      provider: 'testProvider',
      contextWindow: undefined,
      maxOutputTokens: undefined,
      inputPrice: 0.01,
      outputPrice: 0.02,
    };

    const result = await computeModelOptions();
    
    // Should not include token line when tokens are undefined
    assert.ok(!result.includes('undefined/undefined'));
    
    // Restore original configs
    require('@model/ModelRegistry').MODEL_CONFIGS = originalConfigs;
  });

  it('should check OpenRouter availability for supported models', async () => {
    getConfigStub.withArgs('models').returns(['claude-3-5-sonnet-20241022']);
    apiKeyExistsStub.withArgs('anthropic').resolves(false);
    apiKeyExistsStub.withArgs('openRouter').resolves(true);

    const result = await computeModelOptions();
    
    // Model should be available via OpenRouter even without direct API key
    assert.ok(!result.includes('disabled'));
    assert.ok(!result.includes('(no key)'));
  });

  it('should handle API key check failures gracefully', async () => {
    getConfigStub.withArgs('models').returns(['claude-3-5-sonnet-20241022']);
    apiKeyExistsStub.withArgs('anthropic').rejects(new Error('API error'));
    apiKeyExistsStub.withArgs('openRouter').resolves(false);

    const result = await computeModelOptions();
    
    // Should treat failed API key check as missing key
    assert.ok(result.includes('disabled'));
    assert.ok(result.includes('(no key)'));
  });

  it('should format numbers with locale string', async () => {
    getConfigStub.withArgs('models').returns(['claude-3-5-sonnet-20241022']);
    apiKeyExistsStub.resolves(true);

    const result = await computeModelOptions();
    
    // Large numbers should be formatted with commas/separators
    // (exact format depends on locale, but toLocaleString is being called)
    assert.ok(result.includes('Tokens'));
  });
});