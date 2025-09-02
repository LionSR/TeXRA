// Standard library imports
import { strict as assert } from 'assert';

// Local imports - model utilities
import { computeModelOptions } from '@model/computeModelOptions';
import { MODEL_CONFIGS } from '@model/ModelRegistry';
import { SecretManager } from '@frontend/secretManager';

// Mock VS Code API
const vscode = {
  workspace: {
    getConfiguration: () => ({
      get: (key: string, defaultValue: any) => {
        if (key === 'models') {
          return ['gpt-4', 'claude-3-opus', 'fake-model', 'model-without-config'];
        }
        return defaultValue;
      },
    }),
  },
};

describe('computeModelOptions', () => {
  let originalApiKeyExists: typeof SecretManager.apiKeyExists;
  let originalModelConfigs: typeof MODEL_CONFIGS;
  
  beforeEach(() => {
    // Save original functions
    originalApiKeyExists = SecretManager.apiKeyExists;
    originalModelConfigs = { ...MODEL_CONFIGS };
    
    // Mock MODEL_CONFIGS for testing
    (MODEL_CONFIGS as any)['gpt-4'] = {
      provider: 'openai',
      contextWindow: 128000,
      inputPrice: 0.01,
      outputPrice: 0.03,
    };
    
    (MODEL_CONFIGS as any)['claude-3-opus'] = {
      provider: 'anthropic',
      contextWindow: 200000,
      inputPrice: 0.015,
      outputPrice: 0.075,
      openrouterFullName: 'anthropic/claude-3-opus',
    };
    
    (MODEL_CONFIGS as any)['fake-model'] = {
      provider: 'fake-provider',
      // Missing contextWindow, inputPrice, outputPrice to test undefined handling
    };
    
    // model-without-config intentionally has no MODEL_CONFIGS entry
    
    // Mock global vscode
    (global as any).vscode = vscode;
  });
  
  afterEach(() => {
    // Restore original functions
    SecretManager.apiKeyExists = originalApiKeyExists;
    Object.keys(MODEL_CONFIGS).forEach(key => delete MODEL_CONFIGS[key]);
    Object.assign(MODEL_CONFIGS, originalModelConfigs);
  });
  
  it('should generate options with formatted metadata for models with configs', async () => {
    // Mock API key existence
    SecretManager.apiKeyExists = async (provider: string) => {
      return provider === 'openai';
    };
    
    const options = await computeModelOptions();
    
    // Check GPT-4 option (has API key)
    assert(options.includes('<option value="gpt-4" data-provider="openai" data-context="128K" data-cost="$0.0100/$0.0300">gpt-4</option>'));
    
    // Check Claude option (no API key, should be disabled)
    assert(options.includes('<option value="claude-3-opus" disabled data-provider="anthropic" data-context="200K" data-cost="$0.0150/$0.0750">claude-3-opus (no key)</option>'));
  });
  
  it('should handle models without configurations', async () => {
    SecretManager.apiKeyExists = async () => false;
    
    const options = await computeModelOptions();
    
    // Model without config should have no data attributes
    assert(options.includes('<option value="model-without-config">model-without-config</option>'));
  });
  
  it('should handle models with undefined metadata gracefully', async () => {
    SecretManager.apiKeyExists = async () => true;
    
    const options = await computeModelOptions();
    
    // fake-model has provider but missing other fields
    assert(options.includes('<option value="fake-model" data-provider="fake-provider">fake-model</option>'));
    // Should NOT include undefined values
    assert(!options.includes('undefined'));
  });
  
  it('should format large context windows correctly', async () => {
    // Add a model with very large context
    (MODEL_CONFIGS as any)['large-context-model'] = {
      provider: 'test',
      contextWindow: 2000000,
      inputPrice: 0.01,
      outputPrice: 0.02,
    };
    
    (vscode.workspace.getConfiguration() as any).get = (key: string, defaultValue: any) => {
      if (key === 'models') {
        return ['large-context-model'];
      }
      return defaultValue;
    };
    
    SecretManager.apiKeyExists = async () => true;
    
    const options = await computeModelOptions();
    
    // Should format as 2.0M
    assert(options.includes('data-context="2.0M"'));
  });
  
  it('should enable models via OpenRouter when available', async () => {
    SecretManager.apiKeyExists = async (provider: string) => {
      return provider === 'openRouter';
    };
    
    const options = await computeModelOptions();
    
    // Claude should be enabled via OpenRouter
    assert(options.includes('<option value="claude-3-opus" data-provider="anthropic"'));
    assert(!options.includes('claude-3-opus (no key)'));
  });
});