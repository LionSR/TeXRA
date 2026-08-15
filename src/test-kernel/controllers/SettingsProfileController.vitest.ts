import { describe, expect, it, vi } from 'vitest';

import {
  SettingsProfileController,
  type SettingsProfileConfigValue,
} from '@controllers/settingsView/SettingsProfileController';
import type { StateStore } from '@platform/interfaces';
import { DEFAULT_CORE_SETTINGS } from '@shared/schemas';
import type { SpendingStatus } from '@shared/schemas';
import type { ProviderSettingDef } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';

const MAX_ATTEMPTS_KEY = 'texra.model.retry.maxAttempts';
const INVALID_MAX_ATTEMPTS = [2.5, 6];
const COMPACTION_KEY = 'texra.model.compactionThresholdPercent';

const providerSettings = {
  openai: [
    {
      key: 'texra.model.useOpenAIResponsesAPI',
      label: 'Responses API',
      description: 'Use Responses API',
      defaultValue: true,
    },
  ],
  google: [
    {
      key: 'texra.model.useGoogleInteractionsServerState',
      label: 'Server state',
      description: 'Use Google server-side conversation state',
      defaultValue: true,
    },
  ],
  openRouter: [
    {
      key: GlobalStateKey.USE_OPENROUTER,
      label: 'Use OpenRouter',
      description: 'Route through OpenRouter',
      globalStateKey: GlobalStateKey.USE_OPENROUTER,
    },
  ],
  kimiCode: [
    {
      key: GlobalStateKey.KIMI_CODE_PREFER,
      label: 'Prefer Kimi Code',
      description: 'Route dual-backend Kimi models through Kimi Code',
      defaultValue: false,
      globalStateKey: GlobalStateKey.KIMI_CODE_PREFER,
    },
  ],
} satisfies Record<string, readonly ProviderSettingDef[]>;

function createController(
  options: {
    state?: StateStore;
    config?: Record<string, SettingsProfileConfigValue>;
    refreshSpendingStatus?: () => Promise<SpendingStatus | null>;
  } = {},
): {
  controller: SettingsProfileController;
  includedAccessUpdates: boolean[];
  invalidations: { count: number };
  config: Record<string, SettingsProfileConfigValue>;
} {
  const includedAccessUpdates: boolean[] = [];
  const invalidations = { count: 0 };
  const config = options.config ?? {};
  const state = options.state ?? new FakeStateStore();

  return {
    controller: new SettingsProfileController({
      globalState: state,
      providerIds: ['openai', 'google', 'openRouter'],
      providerSettings,
      providerDisplayNames: {
        openai: 'OpenAI',
        google: 'Google',
        openRouter: 'OpenRouter',
      },
      providerKeyUrls: {
        openai: 'https://platform.openai.com/api-keys',
        google: 'https://aistudio.google.com/app/apikey',
        openRouter: 'https://openrouter.ai/keys',
      },
      loadProviderKeyStatuses: async () => ({
        openai: 'set',
        google: 'not-set',
        openRouter: 'not-set',
      }),
      getProviderDisplayName: (_provider, defaultName) => defaultName,
      getProviderKeyUrl: (_provider, defaultUrl) => defaultUrl,
      getProviderStreaming: () => true,
      getProviderEndpoint: () => '',
      supportsCustomEndpoint: () => false,
      getConfig: <T>(key: string, defaultValue: T): T =>
        (Object.hasOwn(config, key) ? config[key] : defaultValue) as T,
      updateConfig: async (key, value) => {
        config[key] = value;
      },
      setUseIncludedModelAccess: async (enabled) => {
        includedAccessUpdates.push(enabled);
      },
      refreshSpendingStatus:
        options.refreshSpendingStatus ?? (async () => null),
      invalidateModelOptionsCache: () => {
        invalidations.count += 1;
      },
    }),
    includedAccessUpdates,
    invalidations,
    config,
  };
}

describe('SettingsProfileController', () => {
  it.each([
    ['resolved null', async () => null],
    [
      'rejected refresh',
      async () => Promise.reject(new Error('quota refresh failed')),
    ],
  ])(
    'fails open and mutates included access for a %s quota result',
    async (_result, refreshSpendingStatus) => {
      const state = new FakeStateStore({
        [GlobalStateKey.USE_OPENROUTER]: true,
      });
      const refresh = vi.fn(refreshSpendingStatus);
      const { controller, includedAccessUpdates, invalidations } =
        createController({ state, refreshSpendingStatus: refresh });

      const update = await controller.setApiAccessMode('included');

      expect(refresh).toHaveBeenCalledOnce();
      expect(includedAccessUpdates).toEqual([true]);
      expect(state.get(GlobalStateKey.USE_OPENROUTER, true)).toBe(false);
      expect(invalidations.count).toBe(1);
      expect(update).toEqual({
        kind: 'updated',
        mode: 'included',
        openRouterDisabled: true,
      });
    },
  );

  it('keeps OpenRouter unchanged when switching to personal keys', async () => {
    const state = new FakeStateStore({ [GlobalStateKey.USE_OPENROUTER]: true });
    const { controller, includedAccessUpdates, invalidations } =
      createController({ state });

    const update = await controller.setApiAccessMode('personal');

    expect(includedAccessUpdates).toEqual([false]);
    expect(state.get(GlobalStateKey.USE_OPENROUTER, false)).toBe(true);
    expect(invalidations.count).toBe(1);
    expect(update).toEqual({
      kind: 'updated',
      mode: 'personal',
      openRouterDisabled: false,
    });
  });

  it('rejects exhausted included access after refreshing quota', async () => {
    const state = new FakeStateStore({ [GlobalStateKey.USE_OPENROUTER]: true });
    const refreshSpendingStatus = vi.fn(async () => ({
      currentSpend: 100,
      limit: 100,
      remaining: 0,
      percentUsed: 100,
    }));
    const { controller, includedAccessUpdates, invalidations } =
      createController({ state, refreshSpendingStatus });

    await expect(controller.setApiAccessMode('included')).resolves.toEqual({
      kind: 'rejected',
      reason: 'quota_exhausted',
    });
    expect(refreshSpendingStatus).toHaveBeenCalledOnce();
    expect(includedAccessUpdates).toEqual([]);
    expect(state.get(GlobalStateKey.USE_OPENROUTER, false)).toBe(true);
    expect(invalidations.count).toBe(0);
  });

  it('accepts included access when a fresh quota check has headroom', async () => {
    const refreshSpendingStatus = vi.fn(async () => ({
      currentSpend: 0,
      limit: 100,
      remaining: 100,
      percentUsed: 0,
    }));
    const { controller, includedAccessUpdates } = createController({
      refreshSpendingStatus,
    });

    await expect(
      controller.setApiAccessMode('included'),
    ).resolves.toMatchObject({
      kind: 'updated',
      mode: 'included',
    });
    expect(refreshSpendingStatus).toHaveBeenCalledOnce();
    expect(includedAccessUpdates).toEqual([true]);
  });

  it('updates only whitelisted provider settings', async () => {
    const state = new FakeStateStore();
    const { controller, invalidations } = createController({ state });

    const rejected = await controller.setProviderSetting({
      key: 'texra.unknownSetting',
      value: true,
    });
    const updated = await controller.setProviderSetting({
      key: GlobalStateKey.USE_OPENROUTER,
      value: true,
    });

    expect(rejected).toEqual({
      kind: 'rejected',
      key: 'texra.unknownSetting',
    });
    expect(updated).toEqual({
      kind: 'updated',
      affectsModelAvailability: true,
    });
    expect(state.get(GlobalStateKey.USE_OPENROUTER, false)).toBe(true);
    expect(invalidations.count).toBe(1);
  });

  it('recomputes model options when Prefer Kimi Code is toggled', async () => {
    const state = new FakeStateStore();
    const { controller, invalidations } = createController({ state });

    const updated = await controller.setProviderSetting({
      key: GlobalStateKey.KIMI_CODE_PREFER,
      value: true,
    });

    // Toggling the reroute must refresh the picker, mirroring OpenRouter.
    expect(updated).toEqual({
      kind: 'updated',
      affectsModelAvailability: true,
    });
    expect(state.get(GlobalStateKey.KIMI_CODE_PREFER, false)).toBe(true);
    expect(invalidations.count).toBe(1);
  });

  it('renders declared provider setting defaults when config is unset', async () => {
    const { controller } = createController();

    const message = await controller.buildProfileMessage();
    const google = message.providerKeyStatuses.find(
      (status) => status.provider === 'google',
    );

    expect(google?.providerSettings).toContainEqual(
      expect.objectContaining({
        key: 'texra.model.useGoogleInteractionsServerState',
        value: true,
      }),
    );
  });

  it('keeps reliability settings in config-backed model policy', async () => {
    const { controller, config, invalidations } = createController();

    const result = await controller.setProviderSetting({
      key: MAX_ATTEMPTS_KEY,
      value: 3,
    });

    expect(result).toEqual({
      kind: 'updated',
      affectsModelAvailability: false,
    });
    expect(config[MAX_ATTEMPTS_KEY]).toBe(3);
    expect(invalidations.count).toBe(0);
    expect(controller.getReliabilitySettings()).toContainEqual(
      expect.objectContaining({
        key: MAX_ATTEMPTS_KEY,
        label: 'Automatic retries',
        min: 0,
        max: 5,
        step: 1,
        value: 3,
      }),
    );
  });

  it.each(INVALID_MAX_ATTEMPTS)(
    'rejects invalid automatic retry value %s at the settings boundary',
    async (value) => {
      const { controller, config } = createController();

      const result = await controller.setProviderSetting({
        key: MAX_ATTEMPTS_KEY,
        value,
      });

      expect(result).toEqual({
        kind: 'rejected',
        key: MAX_ATTEMPTS_KEY,
      });
      expect(config).not.toHaveProperty(MAX_ATTEMPTS_KEY);
    },
  );

  it.each(INVALID_MAX_ATTEMPTS)(
    'shows the default when persisted automatic retries are invalid (%s)',
    (value) => {
      const { controller } = createController({
        config: { [MAX_ATTEMPTS_KEY]: value },
      });

      expect(controller.getReliabilitySettings()).toContainEqual(
        expect.objectContaining({
          key: MAX_ATTEMPTS_KEY,
          value: DEFAULT_CORE_SETTINGS.model.retry.maxAttempts,
        }),
      );
    },
  );

  it('does not mask a compaction value that runtime still reads directly', () => {
    const { controller } = createController({
      config: { [COMPACTION_KEY]: 101 },
    });

    expect(controller.getReliabilitySettings()).toContainEqual(
      expect.objectContaining({
        key: COMPACTION_KEY,
        value: 101,
      }),
    );
  });

  it('preserves raw compaction writes without a runtime schema', async () => {
    const { controller, config } = createController();

    const result = await controller.setProviderSetting({
      key: COMPACTION_KEY,
      value: 101,
    });

    expect(result).toEqual({
      kind: 'updated',
      affectsModelAvailability: false,
    });
    expect(config[COMPACTION_KEY]).toBe(101);
  });

  it('defaults reliability settings to DEFAULT_CORE_SETTINGS.model.retry (no drift from the catalog)', () => {
    const { controller } = createController();

    const reliabilitySettings = controller.getReliabilitySettings();

    expect(reliabilitySettings).toContainEqual(
      expect.objectContaining({
        key: MAX_ATTEMPTS_KEY,
        value: DEFAULT_CORE_SETTINGS.model.retry.maxAttempts,
      }),
    );
  });
});
