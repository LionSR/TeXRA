import { createChannelTrace } from '@agent/trace';
import { API_PROVIDERS } from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import type { StateStore } from '@platform/interfaces';
import { isSpendingQuotaExceeded, type SpendingStatus } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type {
  ApiAccessMode,
  NumberSetting,
  ProviderKeyStatus,
  ProviderSetting,
  UpdateProfileMessage,
} from '@shared/schemas/settingsViewMessages';
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_SETTINGS,
  PROVIDER_URLS,
  type ProviderSettingDef,
} from '@shared/constants/providers';
import {
  DEFAULT_CORE_SETTINGS,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  ModelRetryMaxAttemptsSchema,
} from '@shared/schemas/coreSettings';
import {
  getProviderDisplayName,
  getProviderEndpoint,
  getProviderKeyUrl,
  getProviderStreaming,
  supportsCustomEndpoint,
} from '@utils/config/providerConfig';
import { buildProfileMessage } from './ProfileMessageBuilder';

const logger = createChannelTrace('SettingsProfileController');

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

export type ProviderSettingUpdateResult =
  | { kind: 'updated'; affectsModelAvailability: boolean }
  | { kind: 'rejected'; key: string };

export type ApiAccessModeUpdate =
  | {
      readonly kind: 'updated';
      readonly mode: ApiAccessMode;
      readonly openRouterDisabled: boolean;
    }
  | { readonly kind: 'rejected'; readonly reason: 'quota_exhausted' };

/**
 * Provider wiring that is identical on every host: the provider catalog
 * itself and the region-aware lookups built on it. Supplied whole by
 * {@link getSharedProviderProfileDefaults} rather than a `Partial` of the full
 * deps, so the shared fragment is a complete, self-typed object.
 */
export interface SettingsProfileProviderDeps {
  readonly providerIds: readonly string[];
  readonly providerSettings: Record<string, readonly ProviderSettingDef[]>;
  readonly providerDisplayNames: Record<string, string>;
  readonly providerKeyUrls: Record<string, string>;
  getProviderDisplayName(provider: string, defaultName: string): string;
  getProviderKeyUrl(provider: string, defaultUrl: string): string;
  getProviderStreaming(provider: string): boolean;
  getProviderEndpoint(provider: string): string;
  supportsCustomEndpoint(provider: string): boolean;
  invalidateModelOptionsCache(): void;
}

/**
 * Host-supplied storage/secrets wiring: `globalState`,
 * `loadProviderKeyStatuses`, `getConfig`/`updateConfig`,
 * `setUseIncludedModelAccess`, and `refreshSpendingStatus` all depend on
 * host-specific storage and secrets, so each host must supply them. Keeping
 * them a separate, required half of {@link SettingsProfileControllerDeps}
 * means a host that forgets one fails at compile time instead of spreading a
 * `Partial` silently.
 */
interface SettingsProfileHostDeps {
  readonly globalState: StateStore;
  loadProviderKeyStatuses(): Promise<
    Record<string, ProviderKeyStatus['status']>
  >;
  getConfig<T>(key: string, defaultValue: T): T;
  updateConfig(key: string, value: SettingsProfileConfigValue): Promise<void>;
  setUseIncludedModelAccess(enabled: boolean): Promise<void>;
  refreshSpendingStatus(): Promise<SpendingStatus | null>;
}

export interface SettingsProfileControllerDeps
  extends SettingsProfileProviderDeps,
    SettingsProfileHostDeps {}

/**
 * Returns a fresh object per call rather than a shared exported literal, so
 * one host mutating its spread copy (`{ ...getSharedProviderProfileDefaults(), ... }`)
 * can never alias into the other host's controller.
 */
export function getSharedProviderProfileDefaults(): SettingsProfileProviderDeps {
  return {
    providerIds: API_PROVIDERS,
    providerSettings: PROVIDER_SETTINGS,
    providerDisplayNames: PROVIDER_DISPLAY_NAMES,
    providerKeyUrls: PROVIDER_URLS,
    getProviderDisplayName,
    getProviderKeyUrl,
    getProviderStreaming,
    getProviderEndpoint,
    supportsCustomEndpoint,
    invalidateModelOptionsCache,
  };
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
    for (const setting of Object.values(deps.providerSettings).flat()) {
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
    return this.deps.getProviderDisplayName(
      provider,
      this.deps.providerDisplayNames[provider] ?? provider,
    );
  }

  getProviderKeyUrl(provider: string): string | undefined {
    const defaultUrl = this.deps.providerKeyUrls[provider];
    if (!defaultUrl) return undefined;
    return this.deps.getProviderKeyUrl(provider, defaultUrl);
  }

  async setApiAccessMode(mode: ApiAccessMode): Promise<ApiAccessModeUpdate> {
    const includedAccess = mode === 'included';
    let spendingStatus: SpendingStatus | null = null;
    if (includedAccess) {
      try {
        spendingStatus = await this.deps.refreshSpendingStatus();
      } catch (error) {
        // The relay remains authoritative, so an unknown local result must not
        // block the mutation. Preserve the refresh failure in the trace only.
        logger.warn('Included Access quota refresh failed; proceeding', {
          data: { error },
        });
      }
    }
    if (spendingStatus !== null && isSpendingQuotaExceeded(spendingStatus)) {
      return { kind: 'rejected', reason: 'quota_exhausted' };
    }
    await this.deps.setUseIncludedModelAccess(includedAccess);

    let openRouterDisabled = false;
    if (
      includedAccess &&
      this.deps.globalState.get<boolean>(GlobalStateKey.USE_OPENROUTER, false)
    ) {
      // Included Access routes through the TeXRA relay; OpenRouter bypasses it.
      await this.deps.globalState.update(GlobalStateKey.USE_OPENROUTER, false);
      openRouterDisabled = true;
    }

    this.deps.invalidateModelOptionsCache();
    return { kind: 'updated', mode, openRouterDisabled };
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
      this.deps.invalidateModelOptionsCache();
    }
    return { kind: 'updated', affectsModelAvailability };
  }

  /**
   * Map every canonical provider id to its key status and native controls.
   */
  private async getProviderKeyStatuses(): Promise<ProviderKeyStatus[]> {
    const secretStatuses = await this.deps.loadProviderKeyStatuses();
    return this.deps.providerIds.map((provider) => ({
      provider,
      displayName: this.getProviderDisplayName(provider),
      status: secretStatuses[provider] ?? 'not-set',
      keyUrl: this.getProviderKeyUrl(provider) ?? '',
      streaming: this.deps.getProviderStreaming(provider),
      customEndpoint: this.deps.getProviderEndpoint(provider),
      supportsCustomEndpoint: this.deps.supportsCustomEndpoint(provider),
      providerSettings: this.getProviderSettings(provider),
    }));
  }

  private getProviderSettings(provider: string): ProviderSetting[] {
    const defs = this.deps.providerSettings[provider];
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
