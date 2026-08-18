import { Mutex } from 'async-mutex';

import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  parseAuthCallbackCode,
  type AuthCallbackUriParts,
} from './authCallback';
import {
  parseStoredSupabaseSession,
  toStorableSupabaseSession,
  type SupabaseCallbackResult,
  type SupabaseSession,
  type SupabaseSessionLog,
  type SupabaseSessionStorage,
} from './supabaseSessionTypes';
import {
  classifyAuthFailureStatus,
  type AuthTokenProvider,
  type SessionRefreshFailure,
  type SessionTokens,
  type StoredSessionState,
} from './TokenProvider';
import type { SupabaseClient as Client } from '@supabase/supabase-js';

// Public entry point for the session value-object helpers and coordinator.
// Fetch timeout behavior is owned by `@auth/fetchWithTimeout`. Only the symbols
// consumers actually use are forwarded; the Zod schemas and callback/parse
// option types stay internal to `supabaseSessionTypes`.
export {
  DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
  parseStoredSupabaseSession,
  parseTokenExchangeResponse,
  toStorableSupabaseSession,
  type GitHubTokenExchangeResponse,
  type SupabaseCallbackResult,
  type SupabaseSession,
  type SupabaseSessionLog,
  type SupabaseSessionStorage,
} from './supabaseSessionTypes';

export interface SupabaseSessionCoordinatorOptions {
  storage: SupabaseSessionStorage;
  getClient: () => Client;
  whenReady: () => Promise<void>;
  tokenRefreshThresholdMs: number;
  log?: SupabaseSessionLog;
}

const NOOP_SUPABASE_SESSION_LOG: Required<SupabaseSessionLog> = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface StableSessionSnapshot {
  session: SupabaseSession | null;
  version: number;
}

/**
 * Host-neutral coordinator for Supabase session storage, token freshness,
 * OAuth callback conversion, and refresh. Host wrappers own UI and registration.
 */
export class SupabaseSessionCoordinator implements AuthTokenProvider {
  private refreshPromise: Promise<SupabaseSession | null> | null = null;
  private sessionMutationVersion = 0;
  private lastStoredSession: SupabaseSession | null = null;
  private lastStoredSessionVersion = 0;
  private lastRefreshFailure: SessionRefreshFailure | null = null;
  private readonly sessionMutex = new Mutex();
  private readonly log: Required<SupabaseSessionLog>;

  /**
   * Expiry (ms since epoch) of the session this coordinator last read or
   * wrote, or null when the last observation was "no session". Every storage
   * read and write updates it, so a session loaded cold at startup answers
   * {@link isTokenExpiringSoon} without any host seeding it.
   */
  private tokenExpiresAt: number | null = null;

  constructor(private readonly options: SupabaseSessionCoordinatorOptions) {
    this.log = { ...NOOP_SUPABASE_SESSION_LOG, ...options.log };
  }

  async whenReady(): Promise<void> {
    await this.options.whenReady();
  }

  async loadSession(): Promise<SupabaseSession | null> {
    const versionBeforeLoad = this.sessionMutationVersion;
    const session = parseStoredSupabaseSession(
      await this.options.storage.get(),
      { logSource: 'SupabaseSession', warn: this.log.warn },
    );
    // A mutation that committed during the read owns the newer expiry; this
    // read observed the superseded session and must not overwrite it.
    if (versionBeforeLoad === this.sessionMutationVersion) {
      this.tokenExpiresAt = session?.expiresAt ?? null;
    }
    return session;
  }

  async storeSession(session: SupabaseSession): Promise<void> {
    await this.runSessionMutation(session, () =>
      this.options.storage.store(JSON.stringify(session)),
    );
  }

  async clearSession(): Promise<void> {
    await this.runSessionMutation(null, () => this.options.storage.delete());
  }

  /**
   * Whether the last observed session expires within the configured refresh
   * threshold. Synchronous in-memory check for the model-invocation path.
   */
  isTokenExpiringSoon(): boolean {
    if (this.tokenExpiresAt === null) {
      return false;
    }
    return (
      this.tokenExpiresAt - Date.now() < this.options.tokenRefreshThresholdMs
    );
  }

  /**
   * Clear the stored session only if it still has the credential pair observed
   * by the caller. A completed OAuth callback or refresh may replace a session
   * while an older validation request is in flight; that older result must not
   * delete the replacement.
   */
  async clearSessionIfCurrent(expected: SupabaseSession): Promise<boolean> {
    let cleared = false;
    await this.sessionMutex.runExclusive(async () => {
      const current = await this.loadSession();
      if (
        !current ||
        current.accessToken !== expected.accessToken ||
        current.refreshToken !== expected.refreshToken
      ) {
        return;
      }

      this.sessionMutationVersion += 1;
      const mutationVersion = this.sessionMutationVersion;
      await this.options.storage.delete();
      this.lastStoredSession = null;
      this.lastStoredSessionVersion = mutationVersion;
      this.tokenExpiresAt = null;
      cleared = true;
    });

    return cleared;
  }

  /**
   * Ensure the access token is fresh, refreshing proactively if near expiry.
   *
   * @returns Fresh access token, or null if no session or refresh failed.
   */
  async ensureFreshToken(forceRefresh?: boolean): Promise<string | null> {
    const session = await this.getFreshSession(forceRefresh);
    return session?.accessToken ?? null;
  }

  /**
   * Classify one stable stored-session generation. A callback may replace the
   * session while refresh is in flight; in that case retry rather than apply
   * the old credential's failure to the new one.
   */
  async getStoredSessionState(): Promise<StoredSessionState> {
    try {
      for (;;) {
        const before = await this.loadStableSessionSnapshot();
        if (!before.session) return 'none';
        if (await this.getSessionTokens()) return 'authenticated';

        const after = await this.loadStableSessionSnapshot();
        if (!after.session) return 'none';
        if (after.version !== before.version) continue;

        return this.lastRefreshFailure === 'invalid' ? 'invalid' : 'transient';
      }
    } catch (error) {
      this.log.error(
        'SupabaseSession',
        `Error classifying stored session: ${toErrorMessage(error)}`,
      );
      return 'transient';
    }
  }

  /**
   * Read the stored session's account label without attempting a token
   * refresh. Returns null when no session is stored or the data is
   * unreadable — the caller decides whether to surface "N/A".
   */
  async getStoredAccountLabel(): Promise<string | null> {
    const session = await this.loadSession();
    return session?.account.label ?? null;
  }

  getLastRefreshFailure(): SessionRefreshFailure | null {
    return this.lastRefreshFailure;
  }

  /** Get access and refresh tokens from secure storage. */
  async getSessionTokens(): Promise<SessionTokens | null> {
    const session = await this.getFreshSession();
    if (!session) return null;
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    };
  }

  /** Convert a PKCE OAuth callback into a host-neutral session record. */
  async createSessionFromCallback(
    uri: AuthCallbackUriParts,
  ): Promise<SupabaseCallbackResult> {
    const parsedCode = parseAuthCallbackCode(uri);
    return parsedCode.success
      ? this.createSessionViaCodeExchange(parsedCode.code)
      : parsedCode;
  }

  private async createSessionViaCodeExchange(
    code: string,
  ): Promise<SupabaseCallbackResult> {
    const { data, error } = await this.options
      .getClient()
      .auth.exchangeCodeForSession(code);

    if (error || !data.session) {
      // A missing verifier means this callback belongs to a sign-in attempt
      // whose flow state is gone — a link opened on another machine, or one
      // left over from before the session was cleared. GoTrue's own wording
      // for it advises `@supabase/ssr` and cookies, which is meaningless in
      // an editor, so say what the user can actually do.
      return {
        success: false,
        error:
          error?.code === 'pkce_code_verifier_not_found'
            ? 'this sign-in link is no longer valid. It was either opened on ' +
              'another machine or left over from an earlier attempt. Start ' +
              'sign-in again.'
            : error?.message || 'Code exchange failed',
        isAuthError: true,
      };
    }

    return { success: true, session: toStorableSupabaseSession(data.session) };
  }

  /** Refresh session via Supabase native refresh, with concurrency protection. */
  async refreshSession(
    session: SupabaseSession,
    expectedVersion = this.sessionMutationVersion,
  ): Promise<SupabaseSession | null> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.lastRefreshFailure = null;
    this.refreshPromise = this.refreshViaSupabase(session)
      .then((refreshed) =>
        refreshed
          ? this.storeRefreshIfCurrent(refreshed, expectedVersion)
          : null,
      )
      .catch((error) => {
        this.lastRefreshFailure = 'transient';
        this.log.error(
          'SupabaseSession',
          `Error refreshing session: ${toErrorMessage(error)}`,
        );
        return null;
      })
      .finally(() => {
        this.refreshPromise = null;
      });

    return this.refreshPromise;
  }

  private async refreshViaSupabase(
    session: SupabaseSession,
  ): Promise<SupabaseSession | null> {
    const { data, error } = await this.options.getClient().auth.refreshSession({
      refresh_token: session.refreshToken,
    });

    if (error || !data.session) {
      this.lastRefreshFailure = classifyAuthFailureStatus(error?.status);
      return null;
    }

    this.lastRefreshFailure = null;
    return toStorableSupabaseSession(data.session);
  }

  private async getFreshSession(
    forceRefresh?: boolean,
  ): Promise<SupabaseSession | null> {
    try {
      const { session, version } = await this.loadStableSessionSnapshot();
      if (!session) {
        return null;
      }

      const timeUntilExpiry = session.expiresAt - Date.now();

      if (
        forceRefresh ||
        timeUntilExpiry < this.options.tokenRefreshThresholdMs
      ) {
        this.log.info(
          'SupabaseSession',
          `Token expires in ${Math.round(timeUntilExpiry / 1000)}s, refreshing proactively`,
        );
        const refreshed = await this.refreshSession(session, version);
        if (refreshed) return refreshed;
        if (forceRefresh || timeUntilExpiry <= 0) {
          this.log.warn(
            'SupabaseSession',
            forceRefresh
              ? 'Force refresh requested but refresh failed, returning null'
              : 'Token expired and refresh failed, returning null',
          );
          return null;
        }
      }

      this.lastRefreshFailure = null;
      return session;
    } catch (error) {
      this.lastRefreshFailure = 'transient';
      this.log.error(
        'SupabaseSession',
        `Error loading fresh session: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  private async loadStableSession(): Promise<SupabaseSession | null> {
    return (await this.loadStableSessionSnapshot()).session;
  }

  private async loadStableSessionSnapshot(): Promise<StableSessionSnapshot> {
    for (;;) {
      const versionBeforeLoad = this.sessionMutationVersion;
      await this.sessionMutex.waitForUnlock();
      const session = await this.loadSession();
      if (
        versionBeforeLoad === this.sessionMutationVersion &&
        !this.sessionMutex.isLocked()
      ) {
        return { session, version: versionBeforeLoad };
      }
    }
  }

  private async runSessionMutation(
    session: SupabaseSession | null,
    operation: () => Promise<void>,
  ): Promise<void> {
    await this.sessionMutex.runExclusive(async () => {
      this.sessionMutationVersion += 1;
      const mutationVersion = this.sessionMutationVersion;
      await operation();
      this.lastStoredSession = session;
      this.lastStoredSessionVersion = mutationVersion;
      this.tokenExpiresAt = session?.expiresAt ?? null;
    });
  }

  private async storeRefreshIfCurrent(
    refreshed: SupabaseSession,
    expectedVersion: number,
  ): Promise<SupabaseSession | null> {
    if (
      this.sessionMutationVersion !== expectedVersion ||
      this.sessionMutex.isLocked()
    ) {
      return this.loadStableSession();
    }

    await this.storeSession(refreshed);
    return this.isCurrentStoredSession(refreshed)
      ? refreshed
      : this.loadStableSession();
  }

  private isCurrentStoredSession(session: SupabaseSession): boolean {
    return (
      this.lastStoredSessionVersion === this.sessionMutationVersion &&
      this.lastStoredSession?.accessToken === session.accessToken &&
      this.lastStoredSession.refreshToken === session.refreshToken &&
      this.lastStoredSession.id === session.id
    );
  }
}
