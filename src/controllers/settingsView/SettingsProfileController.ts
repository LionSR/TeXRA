import { Effect } from 'effect';
import { SupabaseAuth } from '@auth/SupabaseAuth';
import { API_PROVIDERS } from '@model/apiProviders';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  modelsTabSettings,
  type SettingHost,
} from '@shared/state/stateSettings';
import {
  type ProviderKeyStatus,
  type UpdateProfileMessage,
} from '@shared/settingsView/settingsViewMessages';
import {
  readSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import {
  getProviderDisplayName,
  getProviderEndpoint,
  getProviderKeyUrl,
  supportsCustomEndpoint,
} from '@utils/config/providerConfig';

/**
 * Host-supplied storage wiring: `stores` and `loadProviderKeyStatuses` depend
 * on host-specific storage and secrets, so each host must supply them.
 * Everything else the controller needs — the provider catalog and the
 * region-aware lookups built on it — is host-agnostic and read straight from
 * its modules.
 */
interface SettingsProfileControllerDeps {
  /** The host reading the catalog, so `slots` resolves to its own entry. */
  readonly host: SettingHost;
  /** The three setting slots a catalog row resolves against. */
  readonly stores: SettingsStores;
  /** The host's key-status read, as the program it already was. */
  readonly loadProviderKeyStatuses: Effect.Effect<
    Record<string, ProviderKeyStatus['status']>,
    Error
  >;
}

export class SettingsProfileController {
  constructor(private readonly deps: SettingsProfileControllerDeps) {}

  /**
   * Assemble the canonical `UPDATE_PROFILE` message for either host. The host
   * settles it on its process runtime, which provides `SupabaseAuth`.
   *
   * Profile-metadata reads degrade gracefully: a transient failure keeps the
   * user signed in with fallback values rather than failing the whole refresh.
   */
  readonly buildProfileMessage = Effect.fn(
    'SettingsProfileController.buildProfileMessage',
  )(function* (
    this: SettingsProfileController,
  ): Effect.fn.Return<UpdateProfileMessage, Error, SupabaseAuth> {
    const auth = yield* SupabaseAuth;
    const [storedSessionState, secretStatuses] = yield* Effect.all(
      [auth.storedSessionState, this.deps.loadProviderKeyStatuses],
      { concurrency: 'unbounded' },
    );
    const base = {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      providerKeyStatuses: yield* this.providerKeyStatuses(secretStatuses),
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
      ? yield* auth.storedAccountLabel
      : null;

    if (storedSessionState !== 'authenticated') {
      return {
        ...base,
        authenticated: false,
        user: storedEmail ? { email: storedEmail } : null,
        sessionProblem,
      };
    }

    const user = yield* auth.user;

    return {
      ...base,
      authenticated: true,
      user: { email: user?.email ?? storedEmail ?? '' },
      sessionProblem,
    };
  });

  getProviderDisplayName(provider: string) {
    return getProviderDisplayName(
      this.deps.stores,
      provider,
      PROVIDER_DISPLAY_NAMES[provider] ?? provider,
    );
  }

  /**
   * Map every canonical provider id to its key status and native controls.
   */
  private providerKeyStatuses(
    secretStatuses: Record<string, ProviderKeyStatus['status']>,
  ) {
    return Effect.forEach(API_PROVIDERS, (provider) =>
      Effect.gen({ self: this }, function* () {
        return {
          provider,
          displayName: yield* this.getProviderDisplayName(provider),
          status: secretStatuses[provider] ?? 'not-set',
          keyUrl: (yield* getProviderKeyUrl(this.deps.stores, provider)) ?? '',
          customEndpoint: yield* getProviderEndpoint(
            this.deps.stores,
            provider,
          ),
          supportsCustomEndpoint: supportsCustomEndpoint(provider),
          providerSettings: yield* this.getProviderSettings(provider),
        };
      }),
    );
  }

  private getProviderSettings(provider: string) {
    return Effect.forEach(modelsTabSettings(provider), ({ entry, surface }) =>
      readSetting(entry, this.deps.stores, this.deps.host).pipe(
        Effect.map((value) => {
          const { provider: _provider, ...display } = surface;
          return { ...display, key: entry.key, value: value === true };
        }),
      ),
    );
  }
}
