import { API_PROVIDERS } from '@model/apiProviders';
import type { StateStore } from '@platform/interfaces';
import {
  DEFAULT_CORE_SETTINGS,
  modelsTabSettings,
  type NumberSetting,
  type ProviderKeyStatus,
  type ProviderSetting,
  type SettingHost,
  type StateSettingEntry,
  type UpdateProfileMessage,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  ModelRetryMaxAttemptsSchema,
} from '@shared/schemas';
import { settingDefault, settingSlot } from '@shared/config/settingsAccess';
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_URLS,
} from '@shared/constants/providers';
import {
  getProviderDisplayName,
  getProviderEndpoint,
  getProviderKeyUrl,
  getProviderStreaming,
  supportsCustomEndpoint,
} from '@utils/config/providerConfig';
import { buildProfileMessage } from './ProfileMessageBuilder';

type SettingsReliabilitySetting = Omit<NumberSetting, 'value'> & {
  defaultValue: number;
  schema?: {
    safeParse(value: unknown): { success: boolean };
  };
};

const SETTINGS_RELIABILITY_SETTINGS: readonly SettingsReliabilitySetting[] = [
  {
    key: 'texra.model.compactionThresholdPercent',
    label: 'Compaction threshold',
    description:
      'Context window percentage to trigger automatic context compaction. Set to 0 to disable.',
    min: 0,
    max: 100,
    unit: '%',
    defaultValue: DEFAULT_CORE_SETTINGS.model.compactionThresholdPercent,
  },
  {
    key: 'texra.model.retry.maxAttempts',
    label: 'Automatic retries',
    description: MODEL_RETRY_MAX_ATTEMPTS_SETTING.description,
    min: MODEL_RETRY_MAX_ATTEMPTS_SETTING.min,
    max: MODEL_RETRY_MAX_ATTEMPTS_SETTING.max,
    step: 1,
    defaultValue: DEFAULT_CORE_SETTINGS.model.retry.maxAttempts,
    schema: ModelRetryMaxAttemptsSchema,
  },
];

export type SettingsProfileConfigValue = boolean | number;

type ProviderSettingUpdateResult =
  { kind: 'updated' } | { kind: 'rejected'; key: string };

/**
 * Host-supplied storage/secrets wiring: `globalState`,
 * `loadProviderKeyStatuses`, and `getConfig`/`updateConfig` all depend on
 * host-specific storage and secrets, so each host must supply them. Everything
 * else the controller needs — the provider catalog and the region-aware
 * lookups built on it — is host-agnostic and read straight from its modules.
 */
interface SettingsProfileControllerDeps {
  /** The host reading the catalog, so `slots` resolves to its own entry. */
  readonly host: SettingHost;
  readonly globalState: StateStore;
  loadProviderKeyStatuses(): Promise<
    Record<string, ProviderKeyStatus['status']>
  >;
  getConfig<T>(key: string, defaultValue: T): T;
  updateConfig(key: string, value: SettingsProfileConfigValue): Promise<void>;
}

export class SettingsProfileController {
  private readonly reliabilitySettingsByKey = new Map(
    SETTINGS_RELIABILITY_SETTINGS.map((setting) => [setting.key, setting]),
  );

  constructor(private readonly deps: SettingsProfileControllerDeps) {}

  async buildProfileMessage(): Promise<UpdateProfileMessage> {
    return buildProfileMessage({
      getProviderKeyStatuses: () => this.getProviderKeyStatuses(),
    });
  }

  getReliabilitySettings(): NumberSetting[] {
    return SETTINGS_RELIABILITY_SETTINGS.map((definition) => {
      const { defaultValue, schema, ...setting } = definition;
      const configuredValue = this.deps.getConfig<number>(
        setting.key,
        defaultValue,
      );
      return {
        ...setting,
        value:
          schema && !schema.safeParse(configuredValue).success
            ? defaultValue
            : configuredValue,
      };
    });
  }

  getProviderDisplayName(provider: string): string {
    return getProviderDisplayName(
      provider,
      PROVIDER_DISPLAY_NAMES[provider] ?? provider,
    );
  }

  getProviderKeyUrl(provider: string): string | undefined {
    const defaultUrl = PROVIDER_URLS[provider];
    return defaultUrl ? getProviderKeyUrl(provider, defaultUrl) : undefined;
  }

  /**
   * Numeric reliability settings only. The per-provider toggles this used to
   * also write now go through the generic `UPDATE_STATE_SETTING` catalog path,
   * which validates against the row schema and applies the row's `onWrite`
   * exclusions — the raw `globalState.update` arm that skipped both is gone.
   */
  async setProviderSetting(input: {
    key: string;
    value: SettingsProfileConfigValue;
  }): Promise<ProviderSettingUpdateResult> {
    const reliabilitySetting = this.reliabilitySettingsByKey.get(input.key);
    if (
      !reliabilitySetting ||
      (reliabilitySetting.schema &&
        !reliabilitySetting.schema.safeParse(input.value).success)
    ) {
      return { kind: 'rejected', key: input.key };
    }
    await this.deps.updateConfig(input.key, input.value);
    return { kind: 'updated' };
  }

  /**
   * Map every canonical provider id to its key status and native controls.
   */
  private async getProviderKeyStatuses(): Promise<ProviderKeyStatus[]> {
    const secretStatuses = await this.deps.loadProviderKeyStatuses();
    return API_PROVIDERS.map((provider) => ({
      provider,
      displayName: this.getProviderDisplayName(provider),
      status: secretStatuses[provider] ?? 'not-set',
      keyUrl: this.getProviderKeyUrl(provider) ?? '',
      streaming: getProviderStreaming(provider),
      customEndpoint: getProviderEndpoint(provider),
      supportsCustomEndpoint: supportsCustomEndpoint(provider),
      providerSettings: this.getProviderSettings(provider),
    }));
  }

  /**
   * The provider's Models-tab controls, projected from the catalog rows that
   * declare `surfaces.models` for it. The value and its default-when-absent
   * both come from the row, so the old per-def `defaultValue` fallback ladder
   * has nothing left to fall back through.
   */
  private getProviderSettings(provider: string): ProviderSetting[] {
    return modelsTabSettings(provider).map(({ entry, surface }) => {
      const { provider: _provider, ...display } = surface;
      return { ...display, key: entry.key, value: this.readToggle(entry) };
    });
  }

  /**
   * A Models-tab toggle's current value, read from the slot its row declares
   * for this host. Exhaustive over `SettingStore`: a future row backed by
   * `workspaceState` must fail loudly here rather than read the schema default
   * out of the config tree forever while `writeSetting` persists it elsewhere.
   */
  private readToggle(entry: StateSettingEntry): boolean {
    const fallback = settingDefault(entry) === true;
    const slot = settingSlot(entry, this.deps.host);
    switch (slot) {
      case 'globalState':
        return this.deps.globalState.get<boolean>(entry.key, fallback) === true;
      case 'config':
        return this.deps.getConfig<boolean>(entry.key, fallback);
      case 'workspaceState':
        throw new Error(
          `Models tab row "${entry.key}" is workspaceState-backed, which this controller cannot read`,
        );
    }
  }
}
