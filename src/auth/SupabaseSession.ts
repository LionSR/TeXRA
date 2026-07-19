import { Mutex } from 'async-mutex';

import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  parseAuthCallbackCode,
  parseAuthCallbackTokens,
  type AuthCallbackUriParts,
} from './core/authCallback';
import { fetchWithTimeout } from './fetchWithTimeout';
import {
  firstAccountLabel,
  parseStoredSupabaseSession,
  parseTokenExchangeResponse,
  toStorableSupabaseSession,
  type SupabaseCallbackResult,
  type SupabaseSession,
  type SupabaseSessionLog,
  type SupabaseSessionStorage,
} from './supabaseSessionTypes';
import type { AuthTokenProvider, SessionTokens } from './TokenProvider';
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
  defaultSessionExpiryMs: number;
  githubTokenRefreshUrl: string;
  edgeFunctionTimeoutMs: number;
  fetch?: typeof fetch;
  log?: SupabaseSessionLog;
  onTokenExpiryChanged?: (expiresAt: number | null) => void;
}

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
  private readonly sessionMutex = new Mutex();

  constructor(private readonly options: SupabaseSessionCoordinatorOptions) {}

  async whenReady(): Promise<void> {
    await this.options.whenReady();
  }

  async loadSession(): Promise<SupabaseSession | null> {
    return parseStoredSupabaseSession(await this.options.storage.get(), {
      logSource: 'SupabaseSession',
      warn: this.options.log?.warn,
    });
  }

  async storeSession(session: SupabaseSession): Promise<void> {
    await this.runSessionMutation(session, () =>
      this.options.storage.store(JSON.stringify(session)),
    );
    this.options.onTokenExpiryChanged?.(session.expiresAt);
  }

  async clearSession(): Promise<void> {
    await this.runSessionMutation(null, () => this.options.storage.delete());
    this.options.onTokenExpiryChanged?.(null);
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

  /** Get access and refresh tokens from secure storage. */
  async getSessionTokens(): Promise<SessionTokens | null> {
    const session = await this.getFreshSession();
    if (!session) return null;
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    };
  }

  /**
   * Convert an OAuth callback into a host-neutral session record. PKCE callbacks
   * carry a one-time ?code= that is exchanged for a session; a legacy
   * implicit-flow token callback (tokens in the fragment or query) is kept as a
   * fallback so an older redirect target still authenticates.
   */
  async createSessionFromCallback(
    uri: AuthCallbackUriParts,
  ): Promise<SupabaseCallbackResult> {
    const parsedCode = parseAuthCallbackCode(uri);
    if (parsedCode.success) {
      return this.createSessionViaCodeExchange(parsedCode.code);
    }
    // An explicit error in the callback is terminal for either flow.
    if (parsedCode.isAuthError) {
      return parsedCode;
    }
    // No code present: fall back to the legacy implicit-flow token callback.
    return this.createSessionViaTokens(uri);
  }

  private async createSessionViaCodeExchange(
    code: string,
  ): Promise<SupabaseCallbackResult> {
    const { data, error } = await this.options
      .getClient()
      .auth.exchangeCodeForSession(code);

    if (error || !data.session) {
      return {
        success: false,
        error: error?.message || 'Code exchange failed',
        isAuthError: true,
      };
    }

    return { success: true, session: toStorableSupabaseSession(data.session) };
  }

  private async createSessionViaTokens(
    uri: AuthCallbackUriParts,
  ): Promise<SupabaseCallbackResult> {
    const parsedCallback = parseAuthCallbackTokens(uri);

    if (!parsedCallback.success) return parsedCallback;

    const { accessToken, refreshToken, expiresIn } = parsedCallback.tokens;
    const { data, error: userError } = await this.options
      .getClient()
      .auth.getUser(accessToken);

    if (userError || !data.user) {
      return {
        success: false,
        error: userError?.message || 'User verification failed',
        isAuthError: true,
      };
    }

    const expiresAt = this.getCallbackExpiry(expiresIn);

    return {
      success: true,
      session: {
        id: data.user.id,
        accessToken,
        refreshToken,
        account: {
          id: data.user.id,
          label: firstAccountLabel(data.user.email, data.user.id),
        },
        expiresAt,
      },
    };
  }

  /**
   * Refresh session with concurrency protection.
   * Routes to custom endpoint for GitHub auth sessions, otherwise uses Supabase
   * native refresh.
   */
  async refreshSession(
    session: SupabaseSession,
    expectedVersion = this.sessionMutationVersion,
  ): Promise<SupabaseSession | null> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (
      session.useCustomRefresh
        ? this.refreshViaCustomEndpoint(session)
        : this.refreshViaSupabase(session)
    )
      .then((refreshed) =>
        refreshed
          ? this.storeRefreshIfCurrent(refreshed, expectedVersion)
          : null,
      )
      .catch((error) => {
        this.options.log?.error?.(
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
      return null;
    }

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
        this.options.log?.info?.(
          'SupabaseSession',
          `Token expires in ${Math.round(timeUntilExpiry / 1000)}s, refreshing proactively`,
        );
        const refreshed = await this.refreshSession(session, version);
        if (refreshed) return refreshed;
        if (forceRefresh || timeUntilExpiry <= 0) {
          this.options.log?.warn?.(
            'SupabaseSession',
            forceRefresh
              ? 'Force refresh requested but refresh failed, returning null'
              : 'Token expired and refresh failed, returning null',
          );
          return null;
        }
      }

      return session;
    } catch (error) {
      this.options.log?.error?.(
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
    if (refreshed.useCustomRefresh) {
      this.options.log?.info?.(
        'SupabaseSession',
        'Token refreshed via custom endpoint',
      );
    }
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

  private getCallbackExpiry(expiresIn: string | null): number {
    if (!expiresIn) {
      return Date.now() + this.options.defaultSessionExpiryMs;
    }

    const expiresInSeconds = Number(expiresIn);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      this.options.log?.warn?.(
        'SupabaseSession',
        `Invalid expires_in callback value: ${expiresIn}`,
      );
      return Date.now() + this.options.defaultSessionExpiryMs;
    }

    return Date.now() + expiresInSeconds * 1000;
  }

  private async refreshViaCustomEndpoint(
    session: SupabaseSession,
  ): Promise<SupabaseSession | null> {
    const response = await fetchWithTimeout(
      this.options.githubTokenRefreshUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
      },
      this.options.edgeFunctionTimeoutMs,
      'Token refresh timeout',
      this.options.fetch,
    );

    if (!response.ok) {
      this.options.log?.warn?.(
        'SupabaseSession',
        `Token refresh failed: ${response.status}`,
      );
      return null;
    }

    const data = await parseTokenExchangeResponse(response, this.options.log);
    return toStorableSupabaseSession(data, {
      fallbackLabel: session.account.label,
      defaultExpiryMs: this.options.defaultSessionExpiryMs,
    });
  }
}
