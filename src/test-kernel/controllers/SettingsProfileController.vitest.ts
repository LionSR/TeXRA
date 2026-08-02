import { describe, expect, it } from 'vitest';

import {
  SettingsProfileController,
  type SettingsProfileConfigValue,
} from '@controllers/settingsView/SettingsProfileController';
import type { StateStore } from '@platform/interfaces';
import type { ProviderSettingDef } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { DEFAULT_CORE_SETTINGS } from '@shared/schemas/coreSettings';
import { FakeStateStore } from '@test/support/FakePlatform';

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
      key: 'texra.model.useGoogleInteractionsAPI',
      label: 'Use Interactions API',
      description: 'Use Google Interactions API',
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
  it('turns off OpenRouter when switching to included access', async () => {
    const state = new FakeStateStore({ [GlobalStateKey.USE_OPENROUTER]: true });
    const { controller, includedAccessUpdates, invalidations } =
      createController({ state });

    const update = await controller.setApiAccessMode('included');

    expect(includedAccessUpdates).toEqual([true]);
    expect(state.get(GlobalStateKey.USE_OPENROUTER, true)).toBe(false);
    expect(invalidations.count).toBe(1);
    expect(update).toEqual({
      mode: 'included',
      openRouterDisabled: true,
    });
  });

  it('keeps OpenRouter unchanged when switching to personal keys', async () => {
    const state = new FakeStateStore({ [GlobalStateKey.USE_OPENROUTER]: true });
    const { controller, includedAccessUpdates, invalidations } =
      createController({ state });

    const update = await controller.setApiAccessMode('personal');

    expect(includedAccessUpdates).toEqual([false]);
    expect(state.get(GlobalStateKey.USE_OPENROUTER, false)).toBe(true);
    expect(invalidations.count).toBe(1);
    expect(update).toEqual({
      mode: 'personal',
      openRouterDisabled: false,
    });
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
        key: 'texra.model.useGoogleInteractionsAPI',
        value: true,
      }),
    );
  });

  it('keeps reliability settings in config-backed model policy', async () => {
    const { controller, config, invalidations } = createController();

    const result = await controller.setProviderSetting({
      key: 'texra.model.retry.maxAttempts',
      value: 3,
    });

    expect(result).toEqual({
      kind: 'updated',
      affectsModelAvailability: false,
    });
    expect(config['texra.model.retry.maxAttempts']).toBe(3);
    expect(invalidations.count).toBe(0);
    expect(controller.getReliabilitySettings()).toContainEqual(
      expect.objectContaining({
        key: 'texra.model.retry.maxAttempts',
        label: 'Automatic retries',
        min: 0,
        max: 5,
        step: 1,
        value: 3,
      }),
    );
  });

  it.each([2.5, 6])(
    'rejects invalid automatic retry value %s at the settings boundary',
    async (value) => {
      const { controller, config } = createController();

      const result = await controller.setProviderSetting({
        key: 'texra.model.retry.maxAttempts',
        value,
      });

      expect(result).toEqual({
        kind: 'rejected',
        key: 'texra.model.retry.maxAttempts',
      });
      expect(config).not.toHaveProperty('texra.model.retry.maxAttempts');
    },
  );

  it.each([2.5, 6])(
    'shows the default when persisted automatic retries are invalid (%s)',
    (value) => {
      const { controller } = createController({
        config: { 'texra.model.retry.maxAttempts': value },
      });

      expect(controller.getReliabilitySettings()).toContainEqual(
        expect.objectContaining({
          key: 'texra.model.retry.maxAttempts',
          value: DEFAULT_CORE_SETTINGS.model.retry.maxAttempts,
        }),
      );
    },
  );

  it('does not mask a compaction value that runtime still reads directly', () => {
    const { controller } = createController({
      config: { 'texra.model.compactionThresholdPercent': 101 },
    });

    expect(controller.getReliabilitySettings()).toContainEqual(
      expect.objectContaining({
        key: 'texra.model.compactionThresholdPercent',
        value: 101,
      }),
    );
  });

  it('preserves raw compaction writes without a runtime schema', async () => {
    const { controller, config } = createController();

    const result = await controller.setProviderSetting({
      key: 'texra.model.compactionThresholdPercent',
      value: 101,
    });

    expect(result).toEqual({
      kind: 'updated',
      affectsModelAvailability: false,
    });
    expect(config['texra.model.compactionThresholdPercent']).toBe(101);
  });

  it('defaults reliability settings to DEFAULT_CORE_SETTINGS.model.retry (no drift from the catalog)', () => {
    const { controller } = createController();

    const reliabilitySettings = controller.getReliabilitySettings();

    expect(reliabilitySettings).toContainEqual(
      expect.objectContaining({
        key: 'texra.model.retry.maxAttempts',
        value: DEFAULT_CORE_SETTINGS.model.retry.maxAttempts,
      }),
    );
  });
});
