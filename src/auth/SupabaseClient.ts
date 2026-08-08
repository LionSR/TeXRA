import {
  createClient,
  SupabaseClient as Client,
  User,
  type SupportedStorage,
} from '@supabase/supabase-js';
import * as logger from '@logger/logUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import {
  SUPABASE_GOTRUE_STORAGE_KEY,
  UserTierSchema,
  type UserTier,
} from './config';
import {
  fetchRelayTokenStatus,
  getCachedRelayTokenState,
  getConfiguredRelayToken,
  markRelayTokenRejected,
} from './relayToken';
import type { SessionSecretStore } from './oauth/sessionAccess';
import type {
  AuthTokenProvider,
  SessionTokens,
  StoredSessionState,
} from './TokenProvider';

/**
 * GoTrue storage for the shared client.
 *
 * Browser OAuth is a two-hop handshake: the window that starts sign-in
 * generates the PKCE `code_verifier`, and the deep link carrying the one-time
 * `?code=` back is delivered by the OS to whichever editor window the host
 * picks — not necessarily that one. GoTrue's own storage is a plain
 * in-process object, so a callback landing in another window (or after the
 * extension host reloaded) found no verifier and failed the exchange with
 * `pkce_code_verifier_not_found`.
 *
 * Every key GoTrue derives from its storage key is PKCE flow state (the
 * `-code-verifier` slots and their flow index); those go to the host secret
 * store, which is shared across windows and survives a reload. The bare
 * storage key is GoTrue's session slot and stays in memory on purpose: the
 * host's own session record remains the single owner of the signed-in
 * session, so nothing session-shaped is ever persisted here.
 *
 * This is the one shape `@supabase/auth-js` accepts, and it is only consulted
 * when `persistSession` is true — hence that flag below.
 *
 * A callback that carries no flow id (TeXRA's does not: the auth-bridge deep
 * link keeps `redirect_to` free of query parameters) clears the fixed verifier
 * key on exchange but leaves its numbered slot behind. GoTrue caps those at
 * five and evicts the oldest, so the leftovers are bounded and hold spent
 * verifiers, which are worthless without their single-use auth code.
 */
function gotrueStorage(
  secrets: SessionSecretStore | undefined,
): SupportedStorage {
  // Writes are mirrored here so a secret-store failure degrades to the old
  // in-process behavior (same-window sign-in still completes) instead of
  // losing the flow outright.
  const memory = new Map<string, string>();
  const flowStore = (key: string): SessionSecretStore | null =>
    secrets !== undefined && key !== SUPABASE_GOTRUE_STORAGE_KEY
      ? secrets
      : null;
  const warn = (action: string, key: string, error: unknown): void => {
    logger.warn(
      'SupabaseClient',
      `Could not ${action} PKCE flow state (${key}); sign-in will only be ` +
        `completable in this window: ${toErrorMessage(error)}`,
    );
  };

  return {
    getItem: async (key) => {
      const store = flowStore(key);
      if (!store) return memory.get(key) ?? null;
      try {
        return (await store.get(key)) ?? null;
      } catch (error) {
        warn('read', key, error);
        return memory.get(key) ?? null;
      }
    },
    setItem: async (key, value) => {
      memory.set(key, value);
      const store = flowStore(key);
      if (!store) return;
      try {
        await store.set(key, value);
      } catch (error) {
        warn('store', key, error);
      }
    },
    removeItem: async (key) => {
      memory.delete(key);
      const store = flowStore(key);
      if (!store) return;
      try {
        await store.delete(key);
      } catch (error) {
        warn('clear', key, error);
      }
    },
  };
}

/**
 * Singleton Supabase client with authentication helpers.
 * This is the single source of truth for auth initialization state.
 */
export class SupabaseClient {
  private static instance: Client | null = null;
  private static config: { url: string; publicKey: string } | null = null;
  private static authProvider: AuthTokenProvider | null = null;

  /**
   * Error that occurred during initialization, if any.
   * Used to provide meaningful error messages to users.
   */
  private static initError: Error | null = null;
  private static readinessError: Error | null = null;

  /**
   * Register an auth provider for token refresh.
   * Called by SupabaseAuthProvider on initialization.
   */
  static setAuthProvider(provider: AuthTokenProvider): void {
    this.authProvider = provider;
  }

  /** Reset singleton state between unit tests. */
  static resetForTests(): void {
    this.instance = null;
    this.config = null;
    this.authProvider = null;
    this.initError = null;
    this.readinessError = null;
  }

  /**
   * Record an initialization error for later retrieval.
   * Allows surfacing meaningful error messages to users.
   */
  static setInitError(error: Error): void {
    this.initError = error;
  }

  /**
   * Get initialization error if any occurred.
   */
  static getInitError(): Error | null {
    return this.initError ?? this.readinessError;
  }

  /**
   * Check whether the stored session's token is close enough to expiry that
   * the auth provider would refresh it. Synchronous and in-memory — safe to
   * call before every model invocation. Returns false when no auth provider is
   * registered or it has observed no session.
   */
  static isTokenExpiringSoon(): boolean {
    return this.authProvider?.isTokenExpiringSoon() ?? false;
  }

  /**
   * Check if auth system is fully initialized and ready for use.
   */
  static async isReady(): Promise<boolean> {
    if (
      this.instance === null ||
      this.authProvider === null ||
      this.initError !== null
    ) {
      return false;
    }

    try {
      await this.authProvider.whenReady();
      this.readinessError = null;
      return true;
    } catch (error) {
      this.readinessError = ensureError(error);
      logger.error(
        'SupabaseClient',
        `Auth provider not ready: ${toErrorMessage(error)}`,
      );
      return false;
    }
  }

  /**
   * Initialize the Supabase client with project credentials.
   */
  static initialize(
    url: string,
    publicKey: string,
    secrets?: SessionSecretStore,
  ): void {
    if (!url || !publicKey) {
      throw new Error(
        'Supabase credentials missing. Check the TeXRA configuration.',
      );
    }
    // Idempotent re-init: returning the existing client preserves the pending
    // PKCE flow state across the OAuth round-trip even if a host wires up the
    // auth coordinator more than once.
    if (
      this.instance &&
      this.config?.url === url &&
      this.config?.publicKey === publicKey
    ) {
      return;
    }
    this.config = { url, publicKey };
    this.instance = createClient(url, publicKey, {
      auth: {
        // `persistSession` is what gates GoTrue's use of `storage` at all; the
        // adapter above is what keeps this honest, writing PKCE flow state
        // only and never the session, which the host's secret storage owns.
        persistSession: true,
        storage: gotrueStorage(secrets),
        storageKey: SUPABASE_GOTRUE_STORAGE_KEY,
        autoRefreshToken: false, // Manual refresh via auth provider
        // PKCE: browser OAuth returns a one-time ?code= (not tokens) to the
        // callback, which exchangeCodeForSession trades for a session using
        // the stored verifier, so no access/refresh token ever transits the
        // browser or the auth-bridge page. detectSessionInUrl is off because
        // every host parses its own callback and exchanges the code explicitly.
        flowType: 'pkce',
        detectSessionInUrl: false,
      },
    });
  }

  /**
   * Get the Supabase client instance.
   */
  static getClient(): Client {
    if (!this.instance) {
      throw new Error('Supabase client not initialized. Restart TeXRA.');
    }
    return this.instance;
  }

  /**
   * Get the current GoTrue session access token.
   * Returns null if no session is authenticated or auth system is not ready.
   * @param forceRefresh - When true, forces a token refresh (e.g., after relay 401).
   */
  static async getAccessToken(forceRefresh?: boolean): Promise<string | null> {
    if (!this.authProvider) {
      // Auth provider not set - system not initialized
      return null;
    }

    try {
      return await this.authProvider.ensureFreshToken(forceRefresh);
    } catch (error) {
      logger.error(
        'SupabaseClient',
        `Error getting access token: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Bearer token for TeXRA relay endpoints. A configured CI relay token
   * deliberately overrides the interactive session only for relay-bound calls;
   * PostgREST and Supabase Auth still require a normal GoTrue session token.
   */
  static async getRelayAccessToken(
    forceRefresh?: boolean,
  ): Promise<string | null> {
    const relayToken = getConfiguredRelayToken();
    if (relayToken) {
      if (forceRefresh) {
        // forceRefresh is only set by the relay-401 recovery path, and with
        // a CI token configured that token was the presented credential — so
        // the 401 is authoritative evidence it was rejected. A static token
        // cannot be refreshed; record the rejection (all credential checks
        // then agree) and fall back to the session, which can be.
        markRelayTokenRejected(relayToken);
      } else if (getCachedRelayTokenState(relayToken) !== 'invalid') {
        // Skip a token the server has already rejected (status observed by
        // an earlier async check) — a stored session may still authenticate
        // the call. Cache-only on purpose: this sits on the model-call path
        // and must not add a probe of its own.
        return relayToken;
      }
    }
    return this.getAccessToken(forceRefresh);
  }

  /**
   * Get access and refresh tokens from secure storage.
   * Ensures tokens are fresh before returning.
   */
  static async getSessionTokens(): Promise<SessionTokens | null> {
    if (!this.authProvider) {
      return null;
    }

    try {
      return await this.authProvider.getSessionTokens();
    } catch (error) {
      logger.error(
        'SupabaseClient',
        `Error getting session tokens: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Get the current authenticated user.
   */
  static async getUser(): Promise<User | null> {
    const token = await this.getAccessToken();
    if (!token) return null;

    try {
      const { data, error } = await this.getClient().auth.getUser(token);
      if (error || !data.user) return null;
      return data.user;
    } catch (error) {
      logger.error(
        'SupabaseClient',
        `Error getting user: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Get user tier from the database.
   * Returns the actual tier value: 'free', 'Max', or 'Ultra'.
   */
  static async getUserTier(): Promise<UserTier> {
    // CI relay tokens are not GoTrue sessions, so the session profile query
    // can't run on them. The relay's tier-config endpoint resolves the token
    // to its owning user's tier — the only profile surface a relay-scoped
    // token has.
    const relayToken = getConfiguredRelayToken();
    if (relayToken) {
      const status = await fetchRelayTokenStatus(relayToken);
      // A rejected token behaves as if unset (a stored session may still
      // provide the context); an unverifiable one gates conservatively.
      if (status.state !== 'invalid') {
        return status.state === 'valid' ? status.tier : 'free';
      }
    }

    return this.getSessionTier();
  }

  /**
   * User tier from the stored GoTrue session only, ignoring any
   * configured CI relay token. Use when the operation itself runs on the
   * session (e.g. PostgREST usage reads), so its tier describes the account
   * whose data is being read rather than the relay credential.
   */
  static async getSessionTier(): Promise<UserTier> {
    const defaultTier: UserTier = 'free';

    const tokens = await this.getSessionTokens();
    if (!tokens) return defaultTier;

    try {
      const client = this.getClient();
      await client.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });

      // Fetch the tier from profiles.
      const { data, error } = await client
        .from('profiles')
        .select('tier')
        .single();

      if (error || !data) {
        logger.error(
          'SupabaseClient',
          `Error fetching profile: ${error?.message || 'No data'}`,
        );
        return defaultTier;
      }

      // SQL NULL denotes a profile without an assigned paid tier. A present
      // malformed string is profile corruption: let the outer error path log
      // it before conservatively returning the default tier.
      return UserTierSchema.parse(data.tier ?? defaultTier);
    } catch (error) {
      logger.error(
        'SupabaseClient',
        `Error getting user tier: ${toErrorMessage(error)}`,
      );
      return defaultTier;
    }
  }

  /**
   * Check if user is authenticated.
   */
  static async isAuthenticated(): Promise<boolean> {
    // A configured CI relay token counts unless the server has already
    // rejected it (status observed by an earlier async check); a known-bad
    // token falls through to the stored session. Cache-only on purpose so
    // this stays cheap and offline-safe.
    if (this.hasUsableRelayToken()) {
      return true;
    }
    const token = await this.getAccessToken();
    return token !== null;
  }

  /**
   * Whether a configured relay token remains usable according to the cached
   * server verdict. This check never reads or refreshes the stored session.
   */
  static hasUsableRelayToken(): boolean {
    const relayToken = getConfiguredRelayToken();
    return (
      relayToken !== undefined &&
      getCachedRelayTokenState(relayToken) !== 'invalid'
    );
  }

  /**
   * Whether PostgREST-backed remote agent definitions can be queried.
   * CI relay tokens authenticate model relay endpoints only; this capability
   * deliberately requires a normal GoTrue session access token.
   */
  static async canAccessRemoteAgentCatalog(): Promise<boolean> {
    return (await this.getAccessToken()) !== null;
  }

  /**
   * Health of the stored GoTrue session, independent of any configured relay
   * token. This is the canonical classification for account UI and commands.
   */
  static async getStoredSessionState(): Promise<StoredSessionState> {
    if (!this.authProvider) return 'none';
    return this.authProvider.getStoredSessionState();
  }

  /**
   * Read the stored session's account label without attempting a token
   * refresh. Returns null when no session is stored or no auth provider
   * is registered.
   */
  static async getStoredAccountLabel(): Promise<string | null> {
    if (!this.authProvider) return null;
    try {
      return await this.authProvider.getStoredAccountLabel();
    } catch (error) {
      // Callers render "N/A" for null, so a failed read would otherwise be
      // indistinguishable from "no session stored".
      logger.warn(
        'SupabaseClient',
        `Error reading stored account label: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }
}
