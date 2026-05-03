import { z } from 'zod';
import { toErrorMessage } from '@common/errors/errorMessage';
import {
  parseAuthCallbackTokens,
  type AuthCallbackUriParts,
} from './core/authCallback';
import type { AuthTokenProvider, SessionTokens } from './TokenProvider';
import type {
  Session as SupabaseNativeSession,
  SupabaseClient as Client,
} from '@supabase/supabase-js';

export const DEFAULT_SUPABASE_SESSION_EXPIRY_MS = 60 * 60 * 1000;

export const SupabaseSessionSchema = z.object({
  id: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  account: z.object({
    id: z.string(),
    label: z.string(),
  }),
  expiresAt: z.number(),
  useCustomRefresh: z.boolean().optional(),
});
export type SupabaseSession = z.infer<typeof SupabaseSessionSchema>;

/** Response schema for GitHub token exchange and refresh Edge Functions. */
export const GitHubTokenExchangeSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number().optional(),
  expires_in: z.number().optional(),
  token_type: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string().nullish(),
    user_metadata: z
      .object({
        avatar_url: z.string().optional(),
        user_name: z.string().optional(),
      })
      .optional(),
  }),
});
export type GitHubTokenExchangeResponse = z.infer<
  typeof GitHubTokenExchangeSchema
>;

export interface SupabaseSessionParseOptions {
  logSource?: string;
  warn?: (source: string, message: string) => void;
}

/** Storage boundary for persisted Supabase session data. */
export interface SupabaseSessionStorage {
  get(): Promise<string | undefined>;
  store(sessionData: string): Promise<void>;
  delete(): Promise<void>;
}

export interface SupabaseSessionLog {
  debug?(source: string, message: string): void;
  info?(source: string, message: string): void;
  warn?(source: string, message: string): void;
  error?(source: string, message: string): void;
}

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

/** Result of converting an auth callback into a stored session. */
export interface SupabaseCallbackParseResult {
  success: true;
  session: SupabaseSession;
}

export interface SupabaseCallbackParseError {
  success: false;
  error: string;
  isAuthError?: boolean;
}

export type SupabaseCallbackResult =
  | SupabaseCallbackParseResult
  | SupabaseCallbackParseError;

/**
 * Parse and validate stored session data.
 * Returns null if session data is missing or invalid.
 * Logs warnings for corrupted data to help diagnose auth issues.
 */
export function parseStoredSupabaseSession(
  sessionData: string | undefined,
  options?: SupabaseSessionParseOptions,
): SupabaseSession | null {
  if (!sessionData) return null;
  const logSource = options?.logSource ?? 'SupabaseSession';
  try {
    const parsed = SupabaseSessionSchema.safeParse(JSON.parse(sessionData));
    if (!parsed.success) {
      options?.warn?.(
        logSource,
        `Stored session has invalid schema: ${parsed.error.message}`,
      );
      return null;
    }
    return parsed.data;
  } catch (error) {
    options?.warn?.(
      logSource,
      `Failed to parse stored session: ${toErrorMessage(error)}`,
    );
    return null;
  }
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  timeoutMessage: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const { signal, cleanup } = combineAbortSignals(
    options.signal ?? undefined,
    controller.signal,
  );
  try {
    return await fetchImpl(url, { ...options, signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    cleanup();
    clearTimeout(timeoutId);
  }
}

function combineAbortSignals(
  upstreamSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  if (!upstreamSignal) {
    return { signal: timeoutSignal, cleanup: () => {} };
  }

  if (typeof AbortSignal.any === 'function') {
    return {
      signal: AbortSignal.any([upstreamSignal, timeoutSignal]),
      cleanup: () => {},
    };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  upstreamSignal.addEventListener('abort', abort, { once: true });
  timeoutSignal.addEventListener('abort', abort, { once: true });
  if (upstreamSignal.aborted || timeoutSignal.aborted) {
    controller.abort();
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      upstreamSignal.removeEventListener('abort', abort);
      timeoutSignal.removeEventListener('abort', abort);
    },
  };
}

export async function parseTokenExchangeResponse(
  response: Response,
  log?: SupabaseSessionLog,
): Promise<GitHubTokenExchangeResponse> {
  const rawData = await response.json();
  const parsed = GitHubTokenExchangeSchema.safeParse(rawData);
  if (!parsed.success) {
    log?.error?.(
      'SupabaseSession',
      `Token exchange response validation failed: ${parsed.error.message}`,
    );
    throw new Error('Invalid response format from authentication server');
  }
  return parsed.data;
}

/**
 * Convert Supabase's native Session to our storage format.
 * Handles the snake_case to camelCase and seconds to milliseconds conversions.
 */
export function toStorableSupabaseSession(
  nativeSession: SupabaseNativeSession,
  options?: { useCustomRefresh?: boolean },
): SupabaseSession {
  return {
    id: nativeSession.user.id,
    accessToken: nativeSession.access_token,
    refreshToken: nativeSession.refresh_token,
    account: {
      id: nativeSession.user.id,
      label: nativeSession.user.email || nativeSession.user.id,
    },
    expiresAt: nativeSession.expires_at
      ? nativeSession.expires_at * 1000
      : Date.now() + DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
    useCustomRefresh: options?.useCustomRefresh,
  };
}

/**
 * Host-neutral coordinator for Supabase session storage, token freshness,
 * OAuth callback conversion, and refresh. Host wrappers own UI and registration.
 */
export class SupabaseSessionCoordinator implements AuthTokenProvider {
  private refreshPromise: Promise<SupabaseSession | null> | null = null;

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
    await this.options.storage.store(JSON.stringify(session));
    this.options.onTokenExpiryChanged?.(session.expiresAt);
  }

  async clearSession(): Promise<void> {
    await this.options.storage.delete();
    this.options.onTokenExpiryChanged?.(null);
  }

  /**
   * Ensure the access token is fresh, refreshing proactively if near expiry.
   *
   * @returns Fresh access token, or null if no session or refresh failed.
   */
  async ensureFreshToken(forceRefresh?: boolean): Promise<string | null> {
    try {
      const session = await this.loadSession();
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
        const refreshed = await this.refreshSession(session);
        if (refreshed) {
          return refreshed.accessToken;
        }
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

      return session.accessToken;
    } catch (error) {
      this.options.log?.error?.(
        'SupabaseSession',
        `Error ensuring fresh token: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  /** Get access and refresh tokens from secure storage. */
  async getSessionTokens(): Promise<SessionTokens | null> {
    if (!(await this.ensureFreshToken())) {
      return null;
    }

    try {
      const session = await this.loadSession();
      if (!session) {
        return null;
      }
      return {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      };
    } catch (error) {
      this.options.log?.error?.(
        'SupabaseSession',
        `Error getting session tokens: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Parse auth callback URI parts, verify the user with Supabase, and build a
   * host-neutral session record.
   */
  async createSessionFromCallback(
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
          label: data.user.email || data.user.id,
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
  ): Promise<SupabaseSession | null> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (
      session.useCustomRefresh
        ? this.refreshViaCustomEndpoint(session)
        : this.refreshViaSupabase(session)
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

    const refreshed = toStorableSupabaseSession(data.session);
    await this.storeSession(refreshed);
    return refreshed;
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
    const refreshed: SupabaseSession = {
      id: data.user.id,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      account: {
        id: data.user.id,
        label: data.user.email || session.account.label,
      },
      expiresAt: data.expires_at
        ? data.expires_at * 1000
        : Date.now() + this.options.defaultSessionExpiryMs,
      useCustomRefresh: true,
    };

    await this.storeSession(refreshed);
    this.options.log?.info?.(
      'SupabaseSession',
      'Token refreshed via custom endpoint',
    );
    return refreshed;
  }
}
