import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPlatform } from '@test/support/setupPlatform';
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
  runtimeModelIds,
} from '@model/runtimeModelRegistry';
import type {
  LanguageModelInfo,
  LanguageModelPort,
} from '@platform/languageModel';

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
    const port = languageModelPort([SONNET]);
    await installPlatform({}, { languageModel: port });

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
        supportsVision: false,
        supportsNativeWebSearch: false,
        supportsNativeCodeExecution: false,
      },
    });
    expect(
      inferPersistedModelHandlerCompatibilityKey('copilot:sonnet46', []),
    ).toBe('ModelHandlerVscodeLm');
  });

  it('marks direct fallbacks that could route through ChatGPT subscription', async () => {
    await installPlatform({}, { languageModel: languageModelPort([GPT_56]) });

    await refreshRuntimeModelRegistry();

    expect(getRuntimeModelDirectFallback('copilot:gpt56', false)).toEqual({
      model: 'gpt56',
      provider: 'openai',
      chatGptSubscriptionEligible: true,
    });
  });

  it('keeps unavailable models resolvable without advertising them as available', async () => {
    await installPlatform(
      {},
      {
        languageModel: languageModelPort([
          { ...SONNET, access: 'unavailable' },
        ]),
      },
    );

    await refreshRuntimeModelRegistry();

    expect(availableRuntimeModelIds()).toEqual([]);
    expect(runtimeModelIds()).toEqual(['copilot:sonnet46']);
    expect(runtimeModelAccess('copilot:sonnet46')).toBe('unavailable');
    expect(getRuntimeModelConfig('copilot:sonnet46')).toBeDefined();
  });

  it('adds accessible native models to the ordinary model options', async () => {
    await installPlatform({}, { languageModel: languageModelPort([SONNET]) });

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
    await installPlatform(
      {},
      {
        languageModel: languageModelPort([
          { ...SONNET, access: 'unavailable' },
        ]),
      },
    );

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
    await installPlatform(
      {},
      {
        languageModel: languageModelPort([
          { ...SONNET, access: 'consent-required' },
        ]),
      },
    );

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
    const port = languageModelPort([{ ...SONNET, access: 'consent-required' }]);
    await installPlatform({}, { languageModel: port });

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
    const unavailablePort = languageModelPort([
      { ...SONNET, access: 'unavailable' },
    ]);
    await installPlatform({}, { languageModel: unavailablePort });
    await expect(requestRuntimeModelAccess('copilot:sonnet46')).resolves.toBe(
      'unavailable',
    );
    expect(unavailablePort.sendRequest).not.toHaveBeenCalled();
  });

  it('omits native models whose capabilities TeXRA cannot establish', async () => {
    await installPlatform(
      {},
      {
        languageModel: languageModelPort([
          {
            ...SONNET,
            id: 'future-model',
            family: 'future-model',
            name: 'Future model',
          },
        ]),
      },
    );

    await refreshRuntimeModelRegistry();

    expect(availableRuntimeModelIds()).toEqual([]);
    expect(getRuntimeModelConfig('copilot:future-model')).toBeUndefined();
  });

  it('replaces native model state after invalidation', async () => {
    await installPlatform({}, { languageModel: languageModelPort([SONNET]) });
    await refreshRuntimeModelRegistry();
    expect(availableRuntimeModelIds()).toEqual(['copilot:sonnet46']);

    invalidateRuntimeModelRegistry();
    expect(getRuntimeModelConfig('copilot:sonnet46')).toBeDefined();
    await installPlatform({}, { languageModel: languageModelPort([]) });
    await refreshRuntimeModelRegistry();

    expect(availableRuntimeModelIds()).toEqual([]);
    expect(getRuntimeModelConfig('copilot:sonnet46')).toBeUndefined();
  });

  it('does not make static models depend on native discovery', async () => {
    await installPlatform(
      {},
      {
        languageModel: {
          ...languageModelPort([]),
          selectModels: async () => {
            throw new Error('native discovery failed');
          },
        },
      },
    );

    await expect(resolveRuntimeModelConfig('gpt55')).resolves.toBeDefined();
  });

  it('keeps static model options available when native discovery fails', async () => {
    await installPlatform({}, { languageModel: languageModelPort([SONNET]) });
    await refreshRuntimeModelRegistry();
    expect(availableRuntimeModelIds()).toEqual(['copilot:sonnet46']);

    invalidateRuntimeModelRegistry();
    await installPlatform(
      {},
      {
        languageModel: {
          ...languageModelPort([]),
          selectModels: async () => {
            throw new Error('native discovery failed');
          },
        },
      },
    );

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
    await installPlatform({}, { languageModel: languageModelPort([SONNET]) });
    await refreshRuntimeModelRegistry();

    invalidateRuntimeModelRegistry();
    await installPlatform(
      {},
      {
        languageModel: {
          ...languageModelPort([]),
          selectModels: async () => {
            throw new Error('native discovery failed');
          },
        },
      },
    );

    await expect(discoveredRuntimeModelConfigEntries()).resolves.toEqual([]);
    expect(runtimeModelIds()).toEqual([]);
  });
});
