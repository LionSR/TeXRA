import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inferPersistedModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityInference';
import {
  computeModelOptionsData,
  invalidateModelOptionsCache,
  type ModelOptionsAccess,
} from '@model/computeModelOptions';
import {
  availableRuntimeModelIds,
  discoveredRuntimeModelConfigEntries,
  getRuntimeModelDirectFallback,
  getRuntimeModelConfig,
  invalidateRuntimeModelRegistry,
  refreshRuntimeModelRegistry,
  requestRuntimeModelAccess,
  resolveRuntimeModelConfig,
  runtimeModelAccess,
  runtimeModelConfigEntries,
} from '@model/runtimeModelRegistry';
import type {
  LanguageModelInfo,
  LanguageModelPort,
} from '@platform/languageModel';
import { installPlatform } from '@test/support/setupPlatform';

const SONNET: LanguageModelInfo = {
  id: 'claude-sonnet-4.6',
  name: 'Claude Sonnet 4.6',
  family: 'claude-sonnet-4.6',
  vendor: 'copilot',
  version: '2026-07',
  maxInputTokens: 160_000,
  access: 'allowed',
};

const GPT_56: LanguageModelInfo = {
  id: 'gpt-5.6',
  name: 'GPT-5.6',
  family: 'gpt-5.6',
  vendor: 'copilot',
  version: '2026-07',
  maxInputTokens: 128_000,
  access: 'allowed',
};

function languageModelPort(
  models: readonly LanguageModelInfo[],
): LanguageModelPort {
  return {
    isAvailable: () => true,
    selectModels: vi.fn(async () => models),
    onDidChangeModels: () => ({ dispose() {} }),
    sendRequest: vi.fn(() =>
      (async function* () {
        yield { kind: 'text' as const, text: 'OK' };
      })(),
    ),
    countTokens: async () => 0,
    onDidChangeAccess: () => ({ dispose() {} }),
  };
}

async function installModels(
  ...models: readonly LanguageModelInfo[]
): Promise<LanguageModelPort> {
  const port = languageModelPort(models);
  await installPlatform({}, { languageModel: port });
  return port;
}

function failingDiscoveryPort(): LanguageModelPort {
  return {
    ...languageModelPort([]),
    selectModels: async () => {
      throw new Error('native discovery failed');
    },
  };
}

function modelOptionsAccess(): ModelOptionsAccess {
  return {
    visibleModels: [],
    secrets: {
      get: async () => undefined,
      getStored: async () => undefined,
      set: async () => {},
      delete: async () => {},
      listStoredKeys: async () => [],
      getEnv: () => undefined,
    },
    useOpenRouter: false,
    serverSideKeyService: {
      canUseServerSideKeys: async () => false,
      getUseIncludedModelAccess: () => false,
      wasQuotaAutoSwitched: () => false,
      isRelayQuotaExceeded: () => false,
      isProviderOnServer: () => false,
      canUseModelSync: () => false,
    },
  };
}

describe('runtime model registry', () => {
  beforeEach(() => {
    invalidateRuntimeModelRegistry();
    invalidateModelOptionsCache();
  });
  afterEach(() => {
    invalidateRuntimeModelRegistry();
    invalidateModelOptionsCache();
  });

  it('projects a known native Copilot model onto shared TeXRA metadata', async () => {
    const port = await installModels(SONNET);

    await refreshRuntimeModelRegistry();

    expect(port.selectModels).toHaveBeenCalledWith({ vendor: 'copilot' });
    expect(availableRuntimeModelIds()).toEqual(['copilot:sonnet46']);
    expect(runtimeModelAccess('copilot:sonnet46')).toBe('allowed');
    expect(getRuntimeModelDirectFallback('copilot:sonnet46', false)).toEqual({
      model: 'sonnet46',
      provider: 'anthropic',
      chatGptSubscriptionEligible: false,
    });
    expect(getRuntimeModelDirectFallback('copilot:sonnet46', true)).toEqual({
      model: 'sonnet46',
      provider: 'openRouter',
      chatGptSubscriptionEligible: false,
    });
    expect(getRuntimeModelConfig('copilot:sonnet46')).toMatchObject({
      name: 'copilot:sonnet46',
      label: 'Copilot · Claude Sonnet 4.6',
      fullName: SONNET.id,
      provider: 'copilot',
      contextWindow: SONNET.maxInputTokens,
      inputPrice: 0,
      outputPrice: 0,
      capabilities: {
        supportsFunctionCalling: true,
        supportsReasoning: false,
        supportsReasoningEffort: false,
        supportsTokenCounting: true,
        supportsVision: true,
        supportsNativeWebSearch: false,
        supportsNativeCodeExecution: false,
      },
    });
    expect(
      inferPersistedModelHandlerCompatibilityKey('copilot:sonnet46', []),
    ).toBe('ModelHandlerVscodeLm');
  });

  it('marks direct fallbacks that could route through ChatGPT subscription', async () => {
    await installModels(GPT_56);

    await refreshRuntimeModelRegistry();

    expect(getRuntimeModelDirectFallback('copilot:gpt56', false)).toEqual({
      model: 'gpt56',
      provider: 'openai',
      chatGptSubscriptionEligible: true,
    });
  });

  it('keeps unavailable models resolvable without advertising them as available', async () => {
    await installModels({ ...SONNET, access: 'unavailable' });

    await refreshRuntimeModelRegistry();

    expect(availableRuntimeModelIds()).toEqual([]);
    expect(runtimeModelAccess('copilot:sonnet46')).toBe('unavailable');
    expect(getRuntimeModelConfig('copilot:sonnet46')).toBeDefined();
  });

  it('adds accessible native models to the ordinary model options', async () => {
    await installModels(SONNET);

    const options = await computeModelOptionsData(
      undefined,
      modelOptionsAccess(),
    );

    expect(options).toEqual([
      expect.objectContaining({
        value: 'copilot:sonnet46',
        provider: 'copilot',
        availability: 'copilot-access',
        availabilityLabel: 'Copilot subscription',
        cost: '$0.000/$0.000',
        disabled: false,
        requiresKey: false,
      }),
    ]);
  });

  it('shows an unavailable persisted Copilot selection', async () => {
    await installModels({ ...SONNET, access: 'unavailable' });

    const [option] = await computeModelOptionsData(
      ['copilot:sonnet46'],
      modelOptionsAccess(),
    );

    expect(option).toMatchObject({
      availability: 'copilot-unavailable',
      availabilityLabel: 'Copilot unavailable',
      disabled: true,
      requiresKey: false,
    });
  });

  it('distinguishes models awaiting consent from unavailable models', async () => {
    await installModels({ ...SONNET, access: 'consent-required' });

    const [option] = await computeModelOptionsData(
      ['copilot:sonnet46'],
      modelOptionsAccess(),
    );

    expect(option).toMatchObject({
      availability: 'copilot-consent-required',
      availabilityLabel: 'Copilot consent required',
      disabled: true,
      requiresKey: false,
    });
  });

  it('requests consent only for a model awaiting the native prompt', async () => {
    const port = await installModels({
      ...SONNET,
      access: 'consent-required',
    });

    await expect(requestRuntimeModelAccess('copilot:sonnet46')).resolves.toBe(
      'requested',
    );
    expect(port.sendRequest).toHaveBeenCalledWith(
      { vendor: 'copilot', id: SONNET.id },
      [
        {
          role: 'user',
          content: [
            {
              kind: 'text',
              text: 'Reply with OK to confirm language-model access for TeXRA.',
            },
          ],
        },
      ],
      { justification: 'Use Copilot models in TeXRA.' },
      expect.any(AbortSignal),
    );

    invalidateRuntimeModelRegistry();
    const unavailablePort = await installModels({
      ...SONNET,
      access: 'unavailable',
    });
    await expect(requestRuntimeModelAccess('copilot:sonnet46')).resolves.toBe(
      'unavailable',
    );
    expect(unavailablePort.sendRequest).not.toHaveBeenCalled();
  });

  it('omits native models whose capabilities TeXRA cannot establish', async () => {
    await installModels({
      ...SONNET,
      id: 'future-model',
      family: 'future-model',
      name: 'Future model',
    });

    await refreshRuntimeModelRegistry();

    expect(availableRuntimeModelIds()).toEqual([]);
    expect(getRuntimeModelConfig('copilot:future-model')).toBeUndefined();
  });

  it('replaces native model state after invalidation', async () => {
    await installModels(SONNET);
    await refreshRuntimeModelRegistry();
    expect(availableRuntimeModelIds()).toEqual(['copilot:sonnet46']);

    invalidateRuntimeModelRegistry();
    expect(getRuntimeModelConfig('copilot:sonnet46')).toBeDefined();
    await installModels();
    await refreshRuntimeModelRegistry();

    expect(availableRuntimeModelIds()).toEqual([]);
    expect(getRuntimeModelConfig('copilot:sonnet46')).toBeUndefined();
  });

  it('does not make static models depend on native discovery', async () => {
    await installPlatform({}, { languageModel: failingDiscoveryPort() });

    await expect(resolveRuntimeModelConfig('gpt55')).resolves.toBeDefined();
  });

  it('keeps static model options available when native discovery fails', async () => {
    await installModels(SONNET);
    await refreshRuntimeModelRegistry();
    expect(availableRuntimeModelIds()).toEqual(['copilot:sonnet46']);

    invalidateRuntimeModelRegistry();
    await installPlatform({}, { languageModel: failingDiscoveryPort() });

    const options = await computeModelOptionsData(
      ['gpt55'],
      modelOptionsAccess(),
    );

    expect(options).toEqual([
      expect.objectContaining({
        value: 'gpt55',
        disabled: true,
      }),
    ]);
    expect(availableRuntimeModelIds()).toEqual([]);
    expect(getRuntimeModelConfig('copilot:sonnet46')).toBeUndefined();
  });

  it('returns an empty discovered catalogue when native discovery fails', async () => {
    await installModels(SONNET);
    await refreshRuntimeModelRegistry();

    invalidateRuntimeModelRegistry();
    await installPlatform({}, { languageModel: failingDiscoveryPort() });

    await expect(discoveredRuntimeModelConfigEntries()).resolves.toEqual([]);
    expect(
      runtimeModelConfigEntries().some(([id]) => id.startsWith('copilot:')),
    ).toBe(false);
  });
});
