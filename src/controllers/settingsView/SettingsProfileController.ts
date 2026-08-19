import { SupabaseClient } from '@auth/SupabaseClient';
import { API_PROVIDERS } from '@model/apiProviders';
import type { StateStore } from '@platform/interfaces';
import { PROFILE_VIEW_COMMANDS } from '@shared/ipc';
import {
  modelsTabSettings,
  type ProviderKeyStatus,
  type ProviderSetting,
  type SettingHost,
  type StateSettingEntry,
  type UpdateProfileMessage,
} from '@shared/schemas';
import { settingDefault, settingSlot } from '@shared/config/settingsAccess';
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_URLS,
} from '@shared/constants/providers';
import {
  getGlobalStreaming,
  getProviderDisplayName,
  getProviderEndpoint,
  getProviderKeyUrl,
  getProviderStreaming,
  supportsCustomEndpoint,
} from '@utils/config/providerConfig';

/**
 * Host-supplied storage wiring: `globalState`, `loadProviderKeyStatuses`, and
 * `getConfig` all depend on host-specific storage and secrets, so each host
 * must supply them. Everything else the controller needs — the provider catalog
 * and the region-aware lookups built on it — is host-agnostic and read straight
 * from its modules.
 */
interface SettingsProfileControllerDeps {
  /** The host reading the catalog, so `slots` resolves to its own entry. */
  readonly host: SettingHost;
  readonly globalState: StateStore;
  loadProviderKeyStatuses(): Promise<
    Record<string, ProviderKeyStatus['status']>
  >;
  getConfig<T>(key: string, defaultValue: T): T;
}

export class SettingsProfileController {
  constructor(private readonly deps: SettingsProfileControllerDeps) {}

  /**
   * Assemble the canonical `UPDATE_PROFILE` message for either host.
   *
   * Profile-metadata reads degrade gracefully: a transient failure keeps the
   * user signed in with fallback values rather than failing the whole refresh.
   */
  async buildProfileMessage(): Promise<UpdateProfileMessage> {
    const [storedSessionState, providerKeyStatuses] = await Promise.all([
      SupabaseClient.getStoredSessionState(),
      this.getProviderKeyStatuses(),
    ]);
    const base = {
      command: PROFILE_VIEW_COMMANDS.UPDATE_PROFILE,
      providerKeyStatuses,
      globalStreamingDefault: getGlobalStreaming(),
    };

    // Preserve the distinction between an authoritatively rejected refresh
    // credential and a transient transport/service failure. Both have a stored
    // account but require different user guidance.
    const hasStoredSession = storedSessionState !== 'none';
    let sessionProblem: UpdateProfileMessage['sessionProblem'] = null;
    if (storedSessionState === 'invalid') {
      sessionProblem = 'expired';
    } else if (storedSessionState === 'transient') {
      sessionProblem = 'unavailable';
    }
    const storedEmail = hasStoredSession
      ? await SupabaseClient.getStoredAccountLabel()
      : null;

    if (storedSessionState !== 'authenticated') {
      return {
        ...base,
        authenticated: false,
        user: storedEmail ? { email: storedEmail } : null,
        sessionProblem,
      };
    }

    const user = await SupabaseClient.getUser();

    return {
      ...base,
      authenticated: true,
      user: { email: user?.email ?? storedEmail ?? 'N/A' },
      sessionProblem,
    };
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
