import { GlobalStateKey } from '@shared/state/stateKeys';
import type {
  ApiAccessMode,
  NumberVscodeSetting,
  ProviderKeyStatus,
  ProviderVscodeSetting,
  UpdateProfileMessage,
} from '@shared/schemas/profileViewMessages';
import type { ProviderVscodeSettingDef } from '@shared/constants/providers';
import { buildProfileMessage } from './ProfileMessageBuilder';
import type { StateStore } from '@platform/interfaces/state';

export type SettingsReliabilitySetting = Omit<NumberVscodeSetting, 'value'> & {
  defaultValue: number;
};

export const SETTINGS_RELIABILITY_SETTINGS: readonly SettingsReliabilitySetting[] =
  [
    {
      key: 'texra.model.compactionThresholdPercent',
      label: 'Compaction threshold',
      description:
        'Context window percentage to trigger automatic context compaction. Set to 0 to disable.',
      min: 0,
      max: 100,
      unit: '%',
      defaultValue: 75,
    },
    {
      key: 'texra.model.retry.maxAttempts',
      label: 'Retry attempts',
      description:
        'Automatic retry attempts before showing a manual retry button. Set to 0 for manual-only.',
      min: 0,
      defaultValue: 0,
    },
    {
      key: 'texra.model.retry.backoffMs',
      label: 'Retry backoff',
      description: 'Base delay between retry attempts.',
      min: 0,
      unit: 'ms',
      defaultValue: 1000,
    },
  ];

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
  private readonly reliabilitySettingKeys = new Set(
    SETTINGS_RELIABILITY_SETTINGS.map((setting) => setting.key),
  );

  constructor(private readonly deps: SettingsProfileControllerDeps) {
    this.providerSettingsByKey = new Map(
      Object.values(deps.providerVscodeSettings)
        .flat()
        .map((setting): [string, ProviderVscodeSettingDef] => [
          setting.key,
          setting,
        ]),
    );
  }

  async buildProfileMessage(): Promise<UpdateProfileMessage> {
    return buildProfileMessage({
      getProviderKeyStatuses: () => this.getProviderKeyStatuses(),
    });
  }

  getReliabilitySettings(): NumberVscodeSetting[] {
    return SETTINGS_RELIABILITY_SETTINGS.map(
      ({ defaultValue, ...setting }) => ({
        ...setting,
        value: this.deps.getConfig<number>(setting.key, defaultValue),
      }),
    );
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
    const isReliabilitySetting = this.reliabilitySettingKeys.has(input.key);
    if (!providerSetting && !isReliabilitySetting) {
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

    const affectsModelAvailability =
      providerSetting?.globalStateKey === GlobalStateKey.USE_OPENROUTER;
    if (affectsModelAvailability) {
      this.deps.invalidateModelOptionsCache();
    }
    return { kind: 'updated', affectsModelAvailability };
  }

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
        ? (this.deps.globalState.get<boolean>(def.globalStateKey, false) ??
          false)
        : this.deps.getConfig<boolean>(def.key, false),
    }));
  }
}
