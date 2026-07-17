import { GlobalStateKey } from '@shared/state/stateKeys';
import type {
  ApiAccessMode,
  NumberVscodeSetting,
  ProviderKeyStatus,
  ProviderVscodeSetting,
  UpdateProfileMessage,
} from '@shared/schemas/profileViewMessages';
import type { ProviderVscodeSettingDef } from '@shared/constants/providers';
import { DEFAULT_CORE_SETTINGS } from '@shared/schemas/coreSettings';
import { buildProfileMessage } from './ProfileMessageBuilder';
import type { StateStore } from '@platform/interfaces';

type SettingsReliabilitySetting = Omit<NumberVscodeSetting, 'value'> & {
  defaultValue: number;
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
    defaultValue: 75,
  },
  {
    key: 'texra.model.retry.maxAttempts',
    label: 'Retry attempts',
    description:
      'Flow-managed retry attempts (Google, OpenRouter 429/408, background transients). Anthropic/OpenAI/OpenAIResponse retries are provider-managed by their SDKs (default 2); this setting does not affect them.',
    min: 0,
    defaultValue: DEFAULT_CORE_SETTINGS.model.retry.maxAttempts,
  },
  {
    key: 'texra.model.retry.backoffMs',
    label: 'Retry backoff',
    description:
      'Base backoff delay in milliseconds between retry attempts for model calls',
    min: 0,
    unit: 'ms',
    defaultValue: DEFAULT_CORE_SETTINGS.model.retry.backoffMs,
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

/**
 * Per-provider data needed to assemble a `ProviderKeyStatus`. Each host resolves
 * these the same way, except `getProviderVscodeSettings`: the VS Code extension
 * fills it from config while the desktop app returns [].
 */
interface ProviderKeyStatusSources {
  readonly providerIds: readonly string[];
  loadProviderKeyStatuses(): Promise<
    Record<string, ProviderKeyStatus['status']>
  >;
  getProviderDisplayName(provider: string): string;
  getProviderKeyUrl(provider: string): string | undefined;
  getProviderStreaming(provider: string): boolean;
  getProviderEndpoint(provider: string): string;
  supportsCustomEndpoint(provider: string): boolean;
  getProviderVscodeSettings(provider: string): ProviderVscodeSetting[];
}

/**
 * Map every provider id to its `ProviderKeyStatus`, keeping the settings
 * profile wire shape in one place.
 */
async function buildProviderKeyStatuses(
  sources: ProviderKeyStatusSources,
): Promise<ProviderKeyStatus[]> {
  const secretStatuses = await sources.loadProviderKeyStatuses();
  return sources.providerIds.map((provider) => ({
    provider,
    displayName: sources.getProviderDisplayName(provider),
    status: secretStatuses[provider] ?? 'not-set',
    keyUrl: sources.getProviderKeyUrl(provider) ?? '',
    streaming: sources.getProviderStreaming(provider),
    customEndpoint: sources.getProviderEndpoint(provider),
    supportsCustomEndpoint: sources.supportsCustomEndpoint(provider),
    vscodeSettings: sources.getProviderVscodeSettings(provider),
  }));
}

export class SettingsProfileController {
  private readonly providerSettingsByKey: Map<string, ProviderVscodeSettingDef>;
  private readonly reliabilitySettingKeys = new Set(
    SETTINGS_RELIABILITY_SETTINGS.map((setting) => setting.key),
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

  private getProviderKeyStatuses(): Promise<ProviderKeyStatus[]> {
    return buildProviderKeyStatuses({
      providerIds: this.deps.providerIds,
      loadProviderKeyStatuses: () => this.deps.loadProviderKeyStatuses(),
      getProviderDisplayName: (provider) =>
        this.getProviderDisplayName(provider),
      getProviderKeyUrl: (provider) => this.getProviderKeyUrl(provider),
      getProviderStreaming: (provider) =>
        this.deps.getProviderStreaming(provider),
      getProviderEndpoint: (provider) =>
        this.deps.getProviderEndpoint(provider),
      supportsCustomEndpoint: (provider) =>
        this.deps.supportsCustomEndpoint(provider),
      getProviderVscodeSettings: (provider) =>
        this.getProviderVscodeSettings(provider),
    });
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
