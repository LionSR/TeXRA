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
  getRuntimeModelConfig,
  invalidateRuntimeModelRegistry,
  refreshRuntimeModelRegistry,
  resolveRuntimeModelConfig,
  runtimeModelAccess,
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
};

function languageModelPort(
  models: readonly LanguageModelInfo[],
  access: boolean | undefined = true,
): LanguageModelPort {
  return {
    isAvailable: () => true,
    selectModels: vi.fn(async () => models),
    onDidChangeModels: () => ({ dispose() {} }),
    sendRequest: () =>
      (async function* () {
        // Registry tests do not make model requests.
      })(),
    countTokens: async () => 0,
    canSendRequest: vi.fn(async () => access),
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
    expect(runtimeModelAccess('copilot:sonnet46')).toBe(true);
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

  it('keeps denied models resolvable without advertising them as available', async () => {
    await installPlatform(
      {},
      { languageModel: languageModelPort([SONNET], false) },
    );

    await refreshRuntimeModelRegistry();

    expect(availableRuntimeModelIds()).toEqual([]);
    expect(runtimeModelAccess('copilot:sonnet46')).toBe(false);
    expect(getRuntimeModelConfig('copilot:sonnet46')).toBeDefined();
  });

  it('adds accessible native models to the ordinary model options', async () => {
    await installPlatform(
      {},
      { languageModel: languageModelPort([SONNET], true) },
    );

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

  it('shows a denied persisted selection as requiring Copilot permission', async () => {
    await installPlatform(
      {},
      { languageModel: languageModelPort([SONNET], false) },
    );

    const [option] = await computeModelOptionsData(
      ['copilot:sonnet46'],
      modelOptionsAccess(),
    );

    expect(option).toMatchObject({
      availability: 'copilot-permission-required',
      availabilityLabel: 'Copilot access required',
      disabled: true,
      requiresKey: false,
    });
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
});
