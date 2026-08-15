import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeModelOptionsData,
  invalidateModelOptionsCache,
  type ModelOptionsAccess,
} from '@model/computeModelOptions';
import {
  copilotRouteUnavailableReason,
  preferredCopilotRouteModels,
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
import { createDeferred } from '@test/support/asyncTestUtils';
import { FakeSecrets } from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';

// The discovered-editor-model fixture must track an llm-zoo base model that
// is active (neither deprecated nor retired) and Copilot-documented (carries
// `copilotFullName`): route resolution filters deprecated/retired configs and
// matches the editor id against the registry's Copilot name. gemini31p
// satisfies both in llm-zoo 1.28.0; gemini36f, the previous pick, is
// deprecated there.
const GEMINI_PRO: LanguageModelInfo = {
  id: 'gemini-3.1-pro-preview',
  name: 'Gemini 3.1 Pro',
  family: 'gemini-3.1-pro-preview',
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

function resetModelCaches(): void {
  invalidateRuntimeModelRegistry();
  invalidateModelOptionsCache();
}

function googleKeySecrets(): FakeSecrets {
  return new FakeSecrets({ [apiKeySecretName('google')]: 'sk-google' });
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
  beforeEach(resetModelCaches);
  afterEach(resetModelCaches);

  it('maps a discovered editor model to a route on its canonical base model', async () => {
    const port = await installModels(GEMINI_PRO);

    await refreshRuntimeModelRegistry();

    expect(port.selectModels).toHaveBeenCalledWith({ vendor: 'copilot' });
    expect(copilotRouteForModel('gemini31p')).toEqual(
      expect.objectContaining({
        access: 'allowed',
        reference: { vendor: 'copilot', id: GEMINI_PRO.id },
        effectiveConfig: expect.objectContaining({
          name: 'gemini31p',
          contextWindow: GEMINI_PRO.maxInputTokens,
          inputPrice: 0,
          outputPrice: 0,
          capabilities: expect.objectContaining({
            supportsReasoningEffort: false,
          }),
        }),
      }),
    );
    expect(getRuntimeModelConfig('gemini31p')?.label).not.toContain('Copilot');
  });

  it('resolves duplicate editor versions deterministically to the newest', async () => {
    await installModels(
      { ...GEMINI_PRO, id: 'gemini-3.1-pro-preview-old', version: '2026-01' },
      { ...GEMINI_PRO, id: 'gemini-3.1-pro-preview', version: '2026-07' },
    );

    await refreshRuntimeModelRegistry();

    expect(copilotRouteForModel('gemini31p')?.reference).toEqual({
      vendor: 'copilot',
      id: 'gemini-3.1-pro-preview',
    });
  });

  it('omits editor models whose capabilities TeXRA cannot establish', async () => {
    await installModels({
      ...GEMINI_PRO,
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
      ...GEMINI_PRO,
      access: 'consent-required',
    });

    await expect(requestRuntimeModelAccess('gemini31p')).resolves.toBe(
      'requested',
    );
    expect(port.sendRequest).toHaveBeenCalledWith(
      { vendor: 'copilot', id: GEMINI_PRO.id },
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
      ...GEMINI_PRO,
      access: 'unavailable',
    });
    await expect(requestRuntimeModelAccess('gemini31p')).resolves.toBe(
      'unavailable',
    );
    expect(unavailablePort.sendRequest).not.toHaveBeenCalled();
  });

  it.each([
    {
      scenario: 'entering the native consent flow',
      rediscoveredAccess: 'consent-required' as const,
      outcome: 'requested',
      sendsProbe: true,
    },
    {
      scenario: 'reporting unavailable',
      rediscoveredAccess: 'unavailable' as const,
      outcome: 'unavailable',
      sendsProbe: false,
    },
  ])(
    're-discovers stale allowed access before $scenario',
    async ({ rediscoveredAccess, outcome, sendsProbe }) => {
      let models: readonly LanguageModelInfo[] = [GEMINI_PRO];
      const port = {
        ...languageModelPort([]),
        selectModels: vi.fn(async () => models),
      };
      await installPlatform({}, { languageModel: port });
      await refreshRuntimeModelRegistry();
      expect(copilotRouteForModel('gemini31p')?.access).toBe('allowed');

      models = [{ ...GEMINI_PRO, access: rediscoveredAccess }];

      await expect(requestRuntimeModelAccess('gemini31p')).resolves.toBe(
        outcome,
      );
      expect(port.selectModels).toHaveBeenCalledTimes(2);
      if (sendsProbe) {
        expect(port.sendRequest).toHaveBeenCalledOnce();
      } else {
        expect(port.sendRequest).not.toHaveBeenCalled();
      }
    },
  );

  it('retries when access invalidation supersedes a forced allowed probe', async () => {
    const port = await installModels(GEMINI_PRO);
    await refreshRuntimeModelRegistry();

    const forced = createDeferred<readonly LanguageModelInfo[]>();
    vi.mocked(port.selectModels)
      .mockReturnValueOnce(forced.promise)
      .mockResolvedValueOnce([{ ...GEMINI_PRO, access: 'unavailable' }]);

    const request = requestRuntimeModelAccess('gemini31p');
    invalidateRuntimeModelRegistry();
    forced.resolve([GEMINI_PRO]);

    await expect(request).resolves.toBe('unavailable');
    expect(port.selectModels).toHaveBeenCalledTimes(3);
    expect(port.sendRequest).not.toHaveBeenCalled();
    expect(copilotRouteForModel('gemini31p')?.access).toBe('unavailable');
  });

  it('fails closed when repeated invalidation supersedes the bounded retry', async () => {
    const port = await installModels(GEMINI_PRO);
    await refreshRuntimeModelRegistry();

    const forced = createDeferred<readonly LanguageModelInfo[]>();
    const retry = createDeferred<readonly LanguageModelInfo[]>();
    const retryStarted = createDeferred<void>();
    vi.mocked(port.selectModels)
      .mockReturnValueOnce(forced.promise)
      .mockImplementationOnce(() => {
        retryStarted.resolve();
        return retry.promise;
      });

    const request = requestRuntimeModelAccess('gemini31p');
    invalidateRuntimeModelRegistry();
    forced.resolve([GEMINI_PRO]);
    await retryStarted.promise;
    invalidateRuntimeModelRegistry();
    retry.resolve([GEMINI_PRO]);

    await expect(request).resolves.toBe('unavailable');
    expect(port.selectModels).toHaveBeenCalledTimes(3);
    expect(port.sendRequest).not.toHaveBeenCalled();
    expect(copilotRouteForModel('gemini31p')?.access).toBe('allowed');
  });

  it('does not let a superseded ordinary discovery overwrite forced access state', async () => {
    const ordinary = createDeferred<readonly LanguageModelInfo[]>();
    const forced = createDeferred<readonly LanguageModelInfo[]>();
    const port = {
      ...languageModelPort([]),
      selectModels: vi
        .fn<() => Promise<readonly LanguageModelInfo[]>>()
        .mockReturnValueOnce(ordinary.promise)
        .mockReturnValueOnce(forced.promise),
    };
    await installPlatform({}, { languageModel: port });

    const staleOrdinaryRefresh = refreshRuntimeModelRegistry();
    const forcedRequest = requestRuntimeModelAccess('gemini31p');
    forced.resolve([{ ...GEMINI_PRO, access: 'unavailable' }]);
    await expect(forcedRequest).resolves.toBe('unavailable');

    // Resolve stale allowed data last: the superseded generation must not
    // overwrite the forced result that authorized the opt-in outcome.
    ordinary.resolve([GEMINI_PRO]);
    await staleOrdinaryRefresh;

    expect((await discoveredCopilotRoutes()).get('gemini31p')?.access).toBe(
      'unavailable',
    );
    expect(port.sendRequest).not.toHaveBeenCalled();
    expect(port.selectModels).toHaveBeenCalledTimes(2);
  });

  it('coalesces overlapping user-initiated fresh discoveries', async () => {
    const port = await installModels(GEMINI_PRO);
    await refreshRuntimeModelRegistry();

    const discovery = createDeferred<readonly LanguageModelInfo[]>();
    vi.mocked(port.selectModels).mockReturnValueOnce(discovery.promise);

    const first = requestRuntimeModelAccess('gemini31p');
    const second = requestRuntimeModelAccess('gemini31p');
    discovery.resolve([{ ...GEMINI_PRO, access: 'unavailable' }]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      'unavailable',
      'unavailable',
    ]);
    expect(port.selectModels).toHaveBeenCalledTimes(2);
  });

  it('keeps a visible non-preferred route after failed opt-in revalidation', async () => {
    const error = new Error('fresh discovery failed');
    let discoveryFails = false;
    const port = {
      ...languageModelPort([]),
      selectModels: vi.fn(async () => {
        if (discoveryFails) throw error;
        return [GEMINI_PRO];
      }),
    };
    await installPlatform({}, { languageModel: port });
    await refreshRuntimeModelRegistry();
    discoveryFails = true;

    await expect(requestRuntimeModelAccess('gemini31p')).rejects.toBe(error);

    // Settings reads through the public asynchronous boundary. Its retry also
    // fails, but the previously visible route remains available for display.
    const visibleRoutes = await discoveredCopilotRoutes();
    expect(visibleRoutes.get('gemini31p')?.access).toBe('allowed');
    expect(preferredCopilotRouteModels()).toEqual([]);
    expect(port.selectModels).toHaveBeenCalledTimes(3);
  });

  it('reports the direct fallback for a base model and a legacy copilot id', async () => {
    await installModels(GEMINI_PRO, GPT_56);
    await refreshRuntimeModelRegistry();

    expect(getRuntimeModelDirectFallback('gemini31p', false)).toEqual({
      model: 'gemini31p',
      provider: 'google',
      chatGptSubscriptionEligible: false,
    });
    expect(getRuntimeModelDirectFallback('gemini31p', true)).toEqual({
      model: 'gemini31p',
      provider: 'openRouter',
      chatGptSubscriptionEligible: false,
    });
    expect(getRuntimeModelDirectFallback('gpt56', false)).toEqual({
      model: 'gpt56',
      provider: 'openai',
      chatGptSubscriptionEligible: true,
    });
  });

  it('reports no route error only when preferred Copilot access is allowed', async () => {
    const port = languageModelPort([GEMINI_PRO]);
    await installPlatform(
      {
        globalState: {
          [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['gemini31p', 'gpt56'],
        },
      },
      { languageModel: port },
    );

    await refreshRuntimeModelRegistry();
    expect(copilotRouteUnavailableReason('gemini31p')).toBeUndefined();
    // A preference for a model the editor does not offer cannot route.
    expect(copilotRouteUnavailableReason('gpt56')).toMatch(
      /does not currently/,
    );

    await setCopilotRoutePreference('gemini31p', false);
    expect(copilotRouteUnavailableReason('gemini31p')).toBeUndefined();
  });

  it('replaces route state after invalidation', async () => {
    await installModels(GEMINI_PRO);
    await refreshRuntimeModelRegistry();
    expect(copilotRouteForModel('gemini31p')).toBeDefined();

    invalidateRuntimeModelRegistry();
    expect(copilotRouteForModel('gemini31p')).toBeDefined();
    await installModels();
    await refreshRuntimeModelRegistry();

    expect(copilotRouteForModel('gemini31p')).toBeUndefined();
  });

  it('discards a discovery that an invalidation superseded mid-flight', async () => {
    const discovery = createDeferred<readonly LanguageModelInfo[]>();
    await installPlatform(
      {},
      {
        languageModel: {
          ...languageModelPort([]),
          selectModels: () => discovery.promise,
        },
      },
    );

    const inFlight = refreshRuntimeModelRegistry();
    invalidateRuntimeModelRegistry();
    discovery.resolve([GEMINI_PRO]);
    await inFlight;

    // The superseded result must not land, and the registry must still be
    // stale enough that the next refresh re-probes the (new) port.
    expect(copilotRouteForModel('gemini31p')).toBeUndefined();

    const port = await installModels(GPT_56);
    await refreshRuntimeModelRegistry();

    expect(port.selectModels).toHaveBeenCalledWith({ vendor: 'copilot' });
    expect(copilotRouteForModel('gpt56')).toBeDefined();
  });

  it('does not make static models depend on native discovery', async () => {
    await installPlatform({}, { languageModel: failingDiscoveryPort() });

    await expect(resolveRuntimeModelConfig('gpt55')).resolves.toBeDefined();
  });

  it('returns the last-known route catalogue when rediscovery fails', async () => {
    await installModels(GEMINI_PRO);
    await refreshRuntimeModelRegistry();

    invalidateRuntimeModelRegistry();
    await installPlatform({}, { languageModel: failingDiscoveryPort() });

    expect((await discoveredCopilotRoutes()).get('gemini31p')?.access).toBe(
      'allowed',
    );
  });
});

describe('Copilot route in model pickers', () => {
  beforeEach(resetModelCaches);
  afterEach(resetModelCaches);

  it('shows a base model available both directly and through Copilot exactly once', async () => {
    const port = languageModelPort([GEMINI_PRO]);
    await installPlatform(
      {
        globalState: {
          [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['gemini31p'],
        },
      },
      { languageModel: port },
    );

    const options = await computeModelOptionsData(
      ['gemini31p'],
      modelOptionsAccess({ secrets: googleKeySecrets() }),
    );

    expect(options).toHaveLength(1);
    expect(options[0]).toEqual(
      expect.objectContaining({
        value: 'gemini31p',
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
    const port = languageModelPort([GEMINI_PRO, GPT_56]);
    await installPlatform({}, { languageModel: port });

    const options = await computeModelOptionsData(
      undefined,
      modelOptionsAccess({ visibleModels: ['gpt55'] }),
    );

    expect(options.map((option) => option.value)).toEqual(['gpt55']);
  });

  it('reports consent-required on the base row without adding entries', async () => {
    const port = languageModelPort([
      { ...GEMINI_PRO, access: 'consent-required' },
    ]);
    await installPlatform(
      {
        globalState: {
          [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['gemini31p'],
        },
      },
      { languageModel: port },
    );

    const options = await computeModelOptionsData(
      undefined,
      modelOptionsAccess({ visibleModels: ['gemini31p'] }),
    );

    expect(options).toHaveLength(1);
    expect(options[0]).toEqual(
      expect.objectContaining({
        value: 'gemini31p',
        availability: 'copilot-consent-required',
        availabilityLabel: 'Copilot approval required',
        disabled: true,
      }),
    );
  });

  it('reports an unavailable route instead of falling back to a direct key', async () => {
    const port = languageModelPort([{ ...GEMINI_PRO, access: 'unavailable' }]);
    await installPlatform(
      {
        globalState: {
          [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['gemini31p'],
        },
      },
      { languageModel: port },
    );

    const options = await computeModelOptionsData(
      ['gemini31p'],
      modelOptionsAccess({ secrets: googleKeySecrets() }),
    );

    expect(options).toHaveLength(1);
    expect(options[0]).toEqual(
      expect.objectContaining({
        value: 'gemini31p',
        availability: 'copilot-unavailable',
        availabilityLabel: 'Copilot unavailable',
        disabled: true,
      }),
    );
  });

  it('leaves non-preferred models on their ordinary routes', async () => {
    const port = languageModelPort([GEMINI_PRO]);
    await installPlatform({}, { languageModel: port });

    const options = await computeModelOptionsData(
      ['gemini31p'],
      modelOptionsAccess({ secrets: googleKeySecrets() }),
    );

    expect(options[0]).toEqual(
      expect.objectContaining({
        value: 'gemini31p',
        availability: 'provider-key',
      }),
    );
    expect(options[0]).not.toHaveProperty('routeLabel');
  });
});
