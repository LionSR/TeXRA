import type { StateStore } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type {
  ApiAccessMode,
  NumberVscodeSetting,
  ProviderKeyStatus,
  ProviderVscodeSetting,
  UpdateProfileMessage,
} from '@shared/schemas/profileViewMessages';
import type { ProviderVscodeSettingDef } from '@shared/constants/providers';
import {
  DEFAULT_CORE_SETTINGS,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  ModelRetryMaxAttemptsSchema,
} from '@shared/schemas/coreSettings';
import { buildProfileMessage } from './ProfileMessageBuilder';

type SettingsReliabilitySetting = Omit<NumberVscodeSetting, 'value'> & {
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

function acceptsReliabilityValue(
  setting: Pick<SettingsReliabilitySetting, 'min' | 'max' | 'step' | 'schema'>,
  value: SettingsProfileConfigValue,
): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (setting.schema) {
    return setting.schema.safeParse(value).success;
  }
  if (setting.min !== undefined && value < setting.min) return false;
  if (setting.max !== undefined && value > setting.max) return false;
  return setting.step === undefined || Number.isInteger(value / setting.step);
}

export type SettingsProfileConfigValue = boolean | number;

export type ProviderVscodeSettingUpdateResult =
  | { kind: 'updated'; affectsModelAvailability: boolean }
  | { kind: 'rejected'; key: string };

export interface ApiAccessModeUpdate {
  readonly mode: ApiAccessMode;
  readonly openRouterDisabled: boolean;
}

export interface SettingsProfileControllerDeps {
  readonly globalState: StateStore;
  readonly providerIds: readonly string[];
  readonly providerVscodeSettings: Record<
    string,
    readonly ProviderVscodeSettingDef[]
  >;
  readonly providerDisplayNames: Record<string, string>;
  readonly providerKeyUrls: Record<string, string>;
  loadProviderKeyStatuses(): Promise<
    Record<string, ProviderKeyStatus['status']>
  >;
  getProviderDisplayName(provider: string, defaultName: string): string;
  getProviderKeyUrl(provider: string, defaultUrl: string): string;
  getProviderStreaming(provider: string): boolean;
  getProviderEndpoint(provider: string): string;
  supportsCustomEndpoint(provider: string): boolean;
  getConfig<T>(key: string, defaultValue: T): T;
  updateConfig(key: string, value: SettingsProfileConfigValue): Promise<void>;
  setUseIncludedModelAccess(enabled: boolean): Promise<void>;
  invalidateModelOptionsCache(): void;
}

export class SettingsProfileController {
  private readonly providerSettingsByKey: Map<string, ProviderVscodeSettingDef>;
  private readonly reliabilitySettingsByKey = new Map(
    SETTINGS_RELIABILITY_SETTINGS.map((setting) => [setting.key, setting]),
  );

  constructor(private readonly deps: SettingsProfileControllerDeps) {
    // Keep the first def per key: some keys (e.g. useBackgroundResponses)
    // appear under multiple providers, and the original lookup resolved to
    // the first match.
    this.providerSettingsByKey = new Map();
    for (const setting of Object.values(deps.providerVscodeSettings).flat()) {
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

  getReliabilitySettings(): NumberVscodeSetting[] {
    return SETTINGS_RELIABILITY_SETTINGS.map((definition) => {
      const { defaultValue, schema: _schema, ...setting } = definition;
      const configuredValue = this.deps.getConfig<number>(
        setting.key,
        defaultValue,
      );
      return {
        ...setting,
        value:
          definition.schema &&
          !definition.schema.safeParse(configuredValue).success
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
    return { mode, openRouterDisabled };
  }

  async setProviderVscodeSetting(input: {
    key: string;
    value: SettingsProfileConfigValue;
  }): Promise<ProviderVscodeSettingUpdateResult> {
    const providerSetting = this.providerSettingsByKey.get(input.key);
    const reliabilitySetting = this.reliabilitySettingsByKey.get(input.key);
    if (
      (!providerSetting && !reliabilitySetting) ||
      (reliabilitySetting &&
        !acceptsReliabilityValue(reliabilitySetting, input.value))
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
   * Map every provider id to its `ProviderKeyStatus`. `vscodeSettings` is the
   * one host-specific field: the VS Code extension fills it from config while
   * the desktop app leaves it empty.
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
      vscodeSettings: this.getProviderVscodeSettings(provider),
    }));
  }

  private getProviderVscodeSettings(provider: string): ProviderVscodeSetting[] {
    const defs = this.deps.providerVscodeSettings[provider.toLowerCase()];
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
