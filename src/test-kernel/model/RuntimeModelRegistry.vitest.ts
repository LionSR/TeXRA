import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inferPersistedModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityInference';
import {
  computeModelOptionsData,
  invalidateModelOptionsCache,
  type ModelOptionsAccess,
} from '@model/computeModelOptions';
import {
  shouldRouteModelThroughCopilot,
  setCopilotRoutePreference,
} from '@model/copilotRouting';
import { apiKeySecretName } from '@model/apiProviders';
import {
  copilotRouteForModel,
  discoveredCopilotRoutes,
  getRuntimeModelConfig,
  getRuntimeModelDirectFallback,
  invalidateRuntimeModelRegistry,
  refreshRuntimeModelRegistry,
  requestRuntimeModelAccess,
  resolveRuntimeModelConfig,
} from '@model/runtimeModelRegistry';
import type {
  LanguageModelInfo,
  LanguageModelPort,
} from '@platform/languageModel';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeSecrets } from '@test/support/FakePlatform';
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

function modelOptionsAccess(
  overrides: Partial<ModelOptionsAccess> = {},
): ModelOptionsAccess {
  return {
    visibleModels: [],
    secrets: new FakeSecrets(),
    useOpenRouter: false,
    serverSideKeyService: {
      canUseServerSideKeys: async () => false,
      getUseIncludedModelAccess: () => false,
      isAuthenticated: async () => false,
      wasQuotaAutoSwitched: () => false,
      isRelayQuotaExceeded: () => false,
      isProviderOnServer: () => false,
      canUseModelSync: () => false,
    },
    ...overrides,
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

  it('maps a discovered editor model to a route on its canonical base model', async () => {
    const port = await installModels(SONNET);

    await refreshRuntimeModelRegistry();

    expect(port.selectModels).toHaveBeenCalledWith({ vendor: 'copilot' });
    expect(copilotRouteForModel('sonnet46')).toEqual(
      expect.objectContaining({
        access: 'allowed',
        reference: { vendor: 'copilot', id: SONNET.id },
        effectiveConfig: expect.objectContaining({
          name: 'sonnet46',
          contextWindow: SONNET.maxInputTokens,
          inputPrice: 0,
          outputPrice: 0,
          capabilities: expect.objectContaining({
            supportsReasoningEffort: false,
          }),
        }),
      }),
    );
    // No synthetic picker identity is materialized for the route.
    expect(copilotRouteForModel('copilot:sonnet46')).toBeUndefined();
    expect(getRuntimeModelConfig('sonnet46')?.label).not.toContain('Copilot');
  });

  it('resolves duplicate editor versions deterministically to the newest', async () => {
    await installModels(
      { ...SONNET, id: 'claude-sonnet-4.6-old', version: '2026-01' },
      { ...SONNET, id: 'claude-sonnet-4.6', version: '2026-07' },
    );

    await refreshRuntimeModelRegistry();

    expect(copilotRouteForModel('sonnet46')?.reference).toEqual({
      vendor: 'copilot',
      id: 'claude-sonnet-4.6',
    });
  });

  it('omits editor models whose capabilities TeXRA cannot establish', async () => {
    await installModels({
      ...SONNET,
      id: 'future-model',
      family: 'future-model',
      name: 'Future model',
    });

    await refreshRuntimeModelRegistry();

    expect(copilotRouteForModel('future-model')).toBeUndefined();
    expect([...(await discoveredCopilotRoutes()).keys()]).toEqual([]);
  });

  it('keeps the exact editor reference for the access-request consent prompt', async () => {
    const port = await installModels({
      ...SONNET,
      access: 'consent-required',
    });

    await expect(requestRuntimeModelAccess('sonnet46')).resolves.toBe(
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
    await expect(requestRuntimeModelAccess('sonnet46')).resolves.toBe(
      'unavailable',
    );
    expect(unavailablePort.sendRequest).not.toHaveBeenCalled();
  });

  it('reports the direct fallback for a base model and a legacy copilot id', async () => {
    await installModels(SONNET, GPT_56);
    await refreshRuntimeModelRegistry();

    expect(getRuntimeModelDirectFallback('sonnet46', false)).toEqual({
      model: 'sonnet46',
      provider: 'anthropic',
      chatGptSubscriptionEligible: false,
    });
    expect(getRuntimeModelDirectFallback('sonnet46', true)).toEqual({
      model: 'sonnet46',
      provider: 'openRouter',
      chatGptSubscriptionEligible: false,
    });
    expect(getRuntimeModelDirectFallback('gpt56', false)).toEqual({
      model: 'gpt56',
      provider: 'openai',
      chatGptSubscriptionEligible: true,
    });
    // Retry panels persisted before #9635 can still carry the synthetic id.
    expect(getRuntimeModelDirectFallback('copilot:sonnet46', false)).toEqual({
      model: 'sonnet46',
      provider: 'anthropic',
      chatGptSubscriptionEligible: false,
    });
  });

  it('normalizes persisted copilot ids to the canonical base model config', async () => {
    await installModels();

    expect(getRuntimeModelConfig('copilot:sonnet46')).toBe(
      getRuntimeModelConfig('sonnet46'),
    );
    expect(getRuntimeModelConfig('copilot:sonnet46')?.provider).toBe(
      'anthropic',
    );
    expect(
      inferPersistedModelHandlerCompatibilityKey('copilot:sonnet46', []),
    ).toBe('ModelHandlerVscodeLm');
  });

  it('routes a preferred model through Copilot only when access is allowed', async () => {
    const port = languageModelPort([SONNET]);
    await installPlatform(
      { globalState: { [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['sonnet46'] } },
      { languageModel: port },
    );

    await refreshRuntimeModelRegistry();
    expect(shouldRouteModelThroughCopilot('sonnet46')).toBe(true);
    // A preference for a model the editor does not offer cannot route.
    expect(shouldRouteModelThroughCopilot('gpt56')).toBe(false);

    await setCopilotRoutePreference('sonnet46', false);
    expect(shouldRouteModelThroughCopilot('sonnet46')).toBe(false);
  });

  it('replaces route state after invalidation', async () => {
    await installModels(SONNET);
    await refreshRuntimeModelRegistry();
    expect(copilotRouteForModel('sonnet46')).toBeDefined();

    invalidateRuntimeModelRegistry();
    expect(copilotRouteForModel('sonnet46')).toBeDefined();
    await installModels();
    await refreshRuntimeModelRegistry();

    expect(copilotRouteForModel('sonnet46')).toBeUndefined();
  });

  it('discards a discovery that an invalidation superseded mid-flight', async () => {
    let releaseDiscovery: (models: readonly LanguageModelInfo[]) => void = () =>
      undefined;
    const deferred = new Promise<readonly LanguageModelInfo[]>((resolve) => {
      releaseDiscovery = resolve;
    });
    await installPlatform(
      {},
      {
        languageModel: {
          ...languageModelPort([]),
          selectModels: () => deferred,
        },
      },
    );

    const inFlight = refreshRuntimeModelRegistry();
    invalidateRuntimeModelRegistry();
    releaseDiscovery([SONNET]);
    await inFlight;

    // The superseded result must not land, and the registry must still be
    // stale enough that the next refresh re-probes the (new) port.
    expect(copilotRouteForModel('sonnet46')).toBeUndefined();

    const port = await installModels(GPT_56);
    await refreshRuntimeModelRegistry();

    expect(port.selectModels).toHaveBeenCalledWith({ vendor: 'copilot' });
    expect(copilotRouteForModel('gpt56')).toBeDefined();
  });

  it('does not make static models depend on native discovery', async () => {
    await installPlatform({}, { languageModel: failingDiscoveryPort() });

    await expect(resolveRuntimeModelConfig('gpt55')).resolves.toBeDefined();
  });

  it('returns an empty route catalogue when native discovery fails', async () => {
    await installModels(SONNET);
    await refreshRuntimeModelRegistry();

    invalidateRuntimeModelRegistry();
    await installPlatform({}, { languageModel: failingDiscoveryPort() });

    await expect(discoveredCopilotRoutes()).resolves.toEqual(new Map());
  });
});

describe('Copilot route in model pickers', () => {
  beforeEach(() => {
    invalidateRuntimeModelRegistry();
    invalidateModelOptionsCache();
  });
  afterEach(() => {
    invalidateRuntimeModelRegistry();
    invalidateModelOptionsCache();
  });

  it('shows a base model available both directly and through Copilot exactly once', async () => {
    const port = languageModelPort([SONNET]);
    await installPlatform(
      {
        globalState: {
          [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['sonnet46'],
        },
      },
      { languageModel: port },
    );

    const options = await computeModelOptionsData(
      ['sonnet46'],
      modelOptionsAccess({
        secrets: new FakeSecrets({
          [apiKeySecretName('anthropic')]: 'sk-anthropic',
        }),
      }),
    );

    expect(options).toHaveLength(1);
    expect(options[0]).toEqual(
      expect.objectContaining({
        value: 'sonnet46',
        availability: 'copilot-access',
        availabilityLabel: 'Copilot subscription',
        routeLabel: 'Via Copilot',
        context: '160K',
        cost: '$0.000/$0.000',
        disabled: false,
        requiresKey: false,
      }),
    );
  });

  it('never appends route rows to the visible model list', async () => {
    const port = languageModelPort([SONNET, GPT_56]);
    await installPlatform({}, { languageModel: port });

    const options = await computeModelOptionsData(
      undefined,
      modelOptionsAccess({ visibleModels: ['gpt55'] }),
    );

    expect(options.map((option) => option.value)).toEqual(['gpt55']);
  });

  it('reports consent-required on the base row without adding entries', async () => {
    const port = languageModelPort([{ ...SONNET, access: 'consent-required' }]);
    await installPlatform(
      {
        globalState: {
          [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['sonnet46'],
        },
      },
      { languageModel: port },
    );

    const options = await computeModelOptionsData(
      undefined,
      modelOptionsAccess({ visibleModels: ['sonnet46'] }),
    );

    expect(options).toHaveLength(1);
    expect(options[0]).toEqual(
      expect.objectContaining({
        value: 'sonnet46',
        availability: 'copilot-consent-required',
        availabilityLabel: 'Copilot consent required',
        disabled: true,
      }),
    );
  });

  it('reports an unavailable route instead of falling back to a direct key', async () => {
    const port = languageModelPort([{ ...SONNET, access: 'unavailable' }]);
    await installPlatform(
      {
        globalState: {
          [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['sonnet46'],
        },
      },
      { languageModel: port },
    );

    const options = await computeModelOptionsData(
      ['sonnet46'],
      modelOptionsAccess({
        secrets: new FakeSecrets({
          [apiKeySecretName('anthropic')]: 'sk-anthropic',
        }),
      }),
    );

    expect(options).toHaveLength(1);
    expect(options[0]).toEqual(
      expect.objectContaining({
        value: 'sonnet46',
        availability: 'copilot-unavailable',
        availabilityLabel: 'Copilot unavailable',
        disabled: true,
      }),
    );
  });

  it('leaves non-preferred models on their ordinary routes', async () => {
    const port = languageModelPort([SONNET]);
    await installPlatform({}, { languageModel: port });

    const options = await computeModelOptionsData(
      ['sonnet46'],
      modelOptionsAccess({
        secrets: new FakeSecrets({
          [apiKeySecretName('anthropic')]: 'sk-anthropic',
        }),
      }),
    );

    expect(options[0]).toEqual(
      expect.objectContaining({
        value: 'sonnet46',
        availability: 'provider-key',
      }),
    );
    expect(options[0]).not.toHaveProperty('routeLabel');
  });
});
