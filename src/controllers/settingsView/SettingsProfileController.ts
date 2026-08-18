import { createLog } from '@logger/logUtils';
import { API_PROVIDERS } from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import type { StateStore } from '@platform/interfaces';
import {
  DEFAULT_CORE_SETTINGS,
  type NumberSetting,
  type ProviderKeyStatus,
  type ProviderSetting,
  type UpdateProfileMessage,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  ModelRetryMaxAttemptsSchema,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_SETTINGS,
  PROVIDER_URLS,
  type ProviderSettingDef,
} from '@shared/constants/providers';
import {
  getProviderDisplayName,
  getProviderEndpoint,
  getProviderKeyUrl,
  getProviderStreaming,
  supportsCustomEndpoint,
} from '@utils/config/providerConfig';
import { buildProfileMessage } from './ProfileMessageBuilder';

const logger = createLog('SettingsProfileController');

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
  | { kind: 'updated'; affectsModelAvailability: boolean }
  | { kind: 'rejected'; key: string };

/**
 * Host-supplied storage/secrets wiring: `globalState`,
 * `loadProviderKeyStatuses`, and `getConfig`/`updateConfig` all depend on
 * host-specific storage and secrets, so each host must supply them. Everything
 * else the controller needs — the provider catalog and the region-aware
 * lookups built on it — is host-agnostic and read straight from its modules.
 */
interface SettingsProfileControllerDeps {
  readonly globalState: StateStore;
  loadProviderKeyStatuses(): Promise<
    Record<string, ProviderKeyStatus['status']>
  >;
  getConfig<T>(key: string, defaultValue: T): T;
  updateConfig(key: string, value: SettingsProfileConfigValue): Promise<void>;
}

export class SettingsProfileController {
  private readonly providerSettingsByKey: Map<string, ProviderSettingDef>;
  private readonly reliabilitySettingsByKey = new Map(
    SETTINGS_RELIABILITY_SETTINGS.map((setting) => [setting.key, setting]),
  );

  constructor(private readonly deps: SettingsProfileControllerDeps) {
    // Keep the first def per key: some keys (e.g. useBackgroundResponses)
    // appear under multiple providers, and the original lookup resolved to
    // the first match.
    this.providerSettingsByKey = new Map();
    for (const setting of Object.values(PROVIDER_SETTINGS).flat()) {
      if (!this.providerSettingsByKey.has(setting.key)) {
        this.providerSettingsByKey.set(setting.key, setting);
      }
    }
  }

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

  async setProviderSetting(input: {
    key: string;
    value: SettingsProfileConfigValue;
  }): Promise<ProviderSettingUpdateResult> {
    const providerSetting = this.providerSettingsByKey.get(input.key);
    const reliabilitySetting = this.reliabilitySettingsByKey.get(input.key);
    if (
      (!providerSetting && !reliabilitySetting) ||
      (reliabilitySetting?.schema &&
        !reliabilitySetting.schema.safeParse(input.value).success)
    ) {
      return { kind: 'rejected', key: input.key };
    }

    if (providerSetting?.globalStateKey) {
      await this.deps.globalState.update(
        providerSetting.globalStateKey,
        input.value,
      );
    } else {
      await this.deps.updateConfig(input.key, input.value);
    }

    // Toggles that re-route models change which entries are available and under
    // which provider they appear, so the picker must be recomputed: OpenRouter
    // (global route) and Prefer Kimi Code (reroutes dual-backend Kimi K3).
    const affectsModelAvailability =
      providerSetting?.globalStateKey === GlobalStateKey.USE_OPENROUTER ||
      providerSetting?.globalStateKey === GlobalStateKey.KIMI_CODE_PREFER;
    if (affectsModelAvailability) {
      invalidateModelOptionsCache();
    }
    return { kind: 'updated', affectsModelAvailability };
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

  private getProviderSettings(provider: string): ProviderSetting[] {
    const defs = PROVIDER_SETTINGS[provider];
    if (!defs) return [];
    return defs.map((def) => ({
      ...def,
      value: def.globalStateKey
        ? (this.deps.globalState.get<boolean>(
            def.globalStateKey,
            def.defaultValue ?? false,
          ) ??
          def.defaultValue ??
          false)
        : this.deps.getConfig<boolean>(def.key, def.defaultValue ?? false),
    }));
  }
}
