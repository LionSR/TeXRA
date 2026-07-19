import {
  createClient,
  SupabaseClient as Client,
  User,
} from '@supabase/supabase-js';
import * as logger from '@logger/logUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import {
  TOKEN_REFRESH_THRESHOLD_MS,
  UserTierSchema,
  type UserTier,
} from './config';
import {
  fetchRelayTokenStatus,
  getCachedRelayTokenState,
  getConfiguredRelayToken,
  markRelayTokenRejected,
} from './relayToken';
import type { AuthTokenProvider, SessionTokens } from './TokenProvider';

/**
 * Singleton Supabase client with authentication helpers.
 * This is the single source of truth for auth initialization state.
 */
export class SupabaseClient {
  private static instance: Client | null = null;
  private static otpInstance: Client | null = null;
  private static config: { url: string; publicKey: string } | null = null;
  private static authProvider: AuthTokenProvider | null = null;

  /**
   * Error that occurred during initialization, if any.
   * Used to provide meaningful error messages to users.
   */
  private static initError: Error | null = null;
  private static readinessError: Error | null = null;

  /**
   * Cached token expiry time (ms since epoch).
   * Updated by SupabaseAuthProvider whenever a session is stored or loaded.
   * Used for fast, synchronous expiry checks before each relay call.
   */
  private static tokenExpiresAt: number | null = null;

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
    this.otpInstance = null;
    this.config = null;
    this.authProvider = null;
    this.initError = null;
    this.readinessError = null;
    this.tokenExpiresAt = null;
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
   * Update the cached token expiry time, or clear it on sign-out.
   * Called by SupabaseAuthProvider when a session is stored, loaded, or removed.
   */
  static setTokenExpiry(expiresAt: number | null): void {
    this.tokenExpiresAt = expiresAt;
  }

  /**
   * Check if the current token will expire within {@link TOKEN_REFRESH_THRESHOLD_MS}.
   * Synchronous and in-memory — safe to call before every model invocation.
   * Returns false if no expiry is tracked (e.g., not authenticated or not using relay).
   */
  static isTokenExpiringSoon(): boolean {
    if (this.tokenExpiresAt === null) {
      return false;
    }
    return this.tokenExpiresAt - Date.now() < TOKEN_REFRESH_THRESHOLD_MS;
  }

  /**
   * Check if auth system is fully initialized and ready for use.
   */
  static async isReady(): Promise<boolean> {
    if (this.instance === null || this.authProvider === null) {
      return false;
    }
    if (this.initError !== null) {
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
  static initialize(url: string, publicKey: string): void {
    if (!url || !publicKey) {
      throw new Error(
        'Supabase credentials missing. Check extension configuration.',
      );
    }
    // Idempotent re-init: returning the existing client preserves the in-memory
    // PKCE code_verifier (persistSession:false) across the OAuth round-trip even
    // if a host wires up the auth coordinator more than once.
    if (
      this.instance &&
      this.config?.url === url &&
      this.config?.publicKey === publicKey
    ) {
      return;
    }
    this.config = { url, publicKey };
    this.otpInstance = null;
    this.instance = createClient(url, publicKey, {
      auth: {
        persistSession: false, // VS Code manages session storage
        autoRefreshToken: false, // Manual refresh via auth provider
        // PKCE: browser OAuth returns a one-time ?code= (not tokens) to the
        // callback. The code_verifier stays in this client and is consumed by
        // exchangeCodeForSession, so no access/refresh token ever transits the
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
      throw new Error(
        'Supabase client not initialized. Restart the extension.',
      );
    }
    return this.instance;
  }

  /**
   * Dedicated implicit-flow client for email magic links. The main client uses
   * PKCE so browser OAuth keeps tokens off the bridge, but a PKCE magic link can
   * only be completed by the same in-memory client instance, so it breaks when
   * the email is opened later or on another device. Implicit magic links carry
   * tokens directly in the callback, which the token-fallback path handles
   * wherever the link is opened.
   */
  static getOtpClient(): Client {
    if (!this.config) {
      throw new Error(
        'Supabase client not initialized. Restart the extension.',
      );
    }
    if (!this.otpInstance) {
      this.otpInstance = createClient(this.config.url, this.config.publicKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          flowType: 'implicit',
          detectSessionInUrl: false,
        },
      });
    }
    return this.otpInstance;
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

      return UserTierSchema.catch('free').parse(data.tier);
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
    const relayToken = getConfiguredRelayToken();
    if (relayToken && getCachedRelayTokenState(relayToken) !== 'invalid') {
      return true;
    }
    const token = await this.getAccessToken();
    return token !== null;
  }

  /**
   * Whether PostgREST-backed remote agent definitions can be queried.
   * CI relay tokens authenticate model relay endpoints only; this capability
   * deliberately requires a normal GoTrue session access token.
   */
  static async canAccessRemoteAgentCatalog(): Promise<boolean> {
    return (await this.getAccessToken()) !== null;
  }

  /** Get configuration for re-initialization. */
  static getConfig(): { url: string; publicKey: string } | null {
    return this.config;
  }
}
