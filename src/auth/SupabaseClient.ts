import {
  createClient,
  SupabaseClient as Client,
  User,
  type SupportedStorage,
} from '@supabase/supabase-js';
import { createLog } from '@logger/logUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { SUPABASE_GOTRUE_STORAGE_KEY } from './config';
import type { SessionSecretStore } from './oauth/sessionAccess';
import type {
  AuthTokenProvider,
  SessionTokens,
  StoredSessionState,
} from './TokenProvider';

const log = createLog('SupabaseClient');

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
function gotrueStorage(secrets: SessionSecretStore): SupportedStorage {
  // Writes are mirrored here so a secret-store failure degrades to the old
  // in-process behavior (same-window sign-in still completes) instead of
  // losing the flow outright.
  const memory = new Map<string, string>();

  /**
   * Run one secret-store operation, unless the key is the session slot. That
   * slot and a failed store both answer `undefined`, which every caller
   * resolves against the memory mirror.
   */
  const onFlowState = async <T>(
    action: string,
    key: string,
    run: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (key === SUPABASE_GOTRUE_STORAGE_KEY) return undefined;
    try {
      return await run();
    } catch (error) {
      log.warn(
        `Could not ${action} PKCE flow state (${key}); sign-in will only be ` +
          `completable in this window: ${toErrorMessage(error)}`,
      );
      return undefined;
    }
  };

  return {
    // A degraded store can answer an absent value instead of throwing (e.g. a
    // locked keychain that denies decryption). The mirrored write is still
    // this window's best answer, so a miss falls back like a failure does.
    getItem: async (key) =>
      (await onFlowState('read', key, () => secrets.get(key))) ??
      memory.get(key) ??
      null,
    setItem: async (key, value) => {
      memory.set(key, value);
      await onFlowState('store', key, () => secrets.set(key, value));
    },
    removeItem: async (key) => {
      memory.delete(key);
      await onFlowState('clear', key, () => secrets.delete(key));
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
      log.error(`Auth provider not ready: ${toErrorMessage(error)}`);
      return false;
    }
  }

  /**
   * Initialize the Supabase client with project credentials.
   */
  static initialize(
    url: string,
    publicKey: string,
    secrets: SessionSecretStore,
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
   * @param forceRefresh - When true, forces a token refresh.
   */
  static async getAccessToken(forceRefresh?: boolean): Promise<string | null> {
    if (!this.authProvider) {
      // Auth provider not set - system not initialized
      return null;
    }

    try {
      return await this.authProvider.ensureFreshToken(forceRefresh);
    } catch (error) {
      log.error(`Error getting access token: ${toErrorMessage(error)}`);
      return null;
    }
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
      log.error(`Error getting session tokens: ${toErrorMessage(error)}`);
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
      log.error(`Error getting user: ${toErrorMessage(error)}`);
      return null;
    }
  }

  /**
   * Check if user is authenticated.
   */
  static async isAuthenticated(): Promise<boolean> {
    return (await this.getAccessToken()) !== null;
  }

  /**
   * Health of the stored GoTrue session. This is the canonical
   * classification for account UI and commands.
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
      log.warn(`Error reading stored account label: ${toErrorMessage(error)}`);
      return null;
    }
  }
}
