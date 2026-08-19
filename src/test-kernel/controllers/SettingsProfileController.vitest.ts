import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SettingsProfileController,
  type SettingsProfileConfigValue,
} from '@controllers/settingsView/SettingsProfileController';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import type { StateStore } from '@platform/interfaces';
import { DEFAULT_CORE_SETTINGS } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';

// The controller reads the shipped provider catalog directly, so the picker
// invalidation it triggers is the real module function; count it here.
vi.mock('@model/computeModelOptions', () => ({
  invalidateModelOptionsCache: vi.fn(),
}));

const MAX_ATTEMPTS_KEY = 'texra.model.retry.maxAttempts';
const INVALID_MAX_ATTEMPTS = [2.5, 6];
const COMPACTION_KEY = 'texra.model.compactionThresholdPercent';

const invalidations = vi.mocked(invalidateModelOptionsCache);

beforeEach(() => {
  invalidations.mockClear();
});

function createController(
  options: {
    state?: StateStore;
    config?: Record<string, SettingsProfileConfigValue>;
  } = {},
): {
  controller: SettingsProfileController;
  config: Record<string, SettingsProfileConfigValue>;
} {
  const config = options.config ?? {};
  const state = options.state ?? new FakeStateStore();

  return {
    controller: new SettingsProfileController({
      host: 'vscode',
      globalState: state,
      loadProviderKeyStatuses: async () => ({
        openai: 'set',
        google: 'not-set',
        openRouter: 'not-set',
      }),
      getConfig: <T>(key: string, defaultValue: T): T =>
        (Object.hasOwn(config, key) ? config[key] : defaultValue) as T,
      updateConfig: async (key, value) => {
        config[key] = value;
      },
    }),
    config,
  };
}

describe('SettingsProfileController', () => {
  it('rejects keys it does not own', async () => {
    // Per-provider toggles moved to the generic catalog write path, so this
    // controller owns only the numeric reliability rows.
    const { controller } = createController();

    expect(
      await controller.setProviderSetting({
        key: 'texra.unknownSetting',
        value: true,
      }),
    ).toEqual({ kind: 'rejected', key: 'texra.unknownSetting' });
    expect(
      await controller.setProviderSetting({
        key: GlobalStateKey.USE_OPENROUTER,
        value: true,
      }),
    ).toEqual({ kind: 'rejected', key: GlobalStateKey.USE_OPENROUTER });
    expect(invalidations).toHaveBeenCalledTimes(0);
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
    const { controller, config } = createController();

    const result = await controller.setProviderSetting({
      key: MAX_ATTEMPTS_KEY,
      value: 3,
    });

    expect(result).toEqual({ kind: 'updated' });
    expect(config[MAX_ATTEMPTS_KEY]).toBe(3);
    expect(invalidations).toHaveBeenCalledTimes(0);
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

    expect(result).toEqual({ kind: 'updated' });
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
