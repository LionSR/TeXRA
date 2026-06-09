// Third-party imports
import { describe, it, afterEach, vi } from 'vitest';

// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - handler under test
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative';

// Modules to stub via vi.spyOn
import * as serverKeysModule from '@auth/serverKeys';
import * as providerConfigModule from '@utils/config/providerConfig';

function buildConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'gpt-5.5',
    label: 'GPT-5.5',
    fullName: 'gpt-5.5-2026-04-15',
    shortName: 'gpt-5.5',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 16384,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
    openrouterFullName: 'openai/gpt-5.5',
    ...overrides,
  };
}

function stubServerSideKeyService(): void {
  vi.spyOn(serverKeysModule, 'getServerSideKeyService').mockReturnValue({
    shouldUseServerSideKeysSync: () => true,
    getUseIncludedModelAccess: () => true,
    canUseServerSideKeys: async () => true,
    getRelayBaseUrl: (provider: string) =>
      `https://relay.example.com/functions/v1/relay/${provider}/v1`,
  } as unknown as ReturnType<typeof serverKeysModule.getServerSideKeyService>);
}

describe('ModelHandlerOpenRouterNative routing precedence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shouldUseServerSideKeys returns false when getUseOpenRouter=true even if server-side keys are available', () => {
    // Simulate: user has "Use Included Access" enabled with a valid server-side key service
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(true);
    stubServerSideKeyService();

    const handler = new ModelHandlerOpenRouterNative(buildConfig());

    // OpenRouter routing must take precedence — server-side relay does not apply here
    assert.equal((handler as any).shouldUseServerSideKeys(), false);
  });

  it('shouldUseServerSideKeys returns false for openRouterOnly=true models regardless of server-side key availability', () => {
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(false);
    stubServerSideKeyService();

    const handler = new ModelHandlerOpenRouterNative(
      buildConfig({ openRouterOnly: true }),
    );

    assert.equal((handler as any).shouldUseServerSideKeys(), false);
  });

  it('shouldUseServerSideKeys respects server-side key service when NOT routing through OpenRouter', () => {
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(false);
    stubServerSideKeyService();

    // Use a non-OpenRouter handler (base class logic), openRouterOnly=false, global toggle off
    // shouldUseServerSideKeys should delegate to the service and return true
    const handler = new ModelHandlerOpenRouterNative(
      buildConfig({ openRouterOnly: false }),
    );

    assert.equal((handler as any).shouldUseServerSideKeys(), true);
  });
});
