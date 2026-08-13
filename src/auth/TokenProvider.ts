export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export type SessionRefreshFailure = 'invalid' | 'transient';
export type StoredSessionState =
  'none' | 'authenticated' | SessionRefreshFailure;

/**
 * Classify an authentication HTTP failure conservatively. Only explicit bad
 * request or unauthorized responses establish that stored credentials are
 * unusable; rate limits, timeouts, and server failures may recover.
 */
export function classifyAuthFailureStatus(
  status: number | undefined,
): SessionRefreshFailure {
  return status === 400 || status === 401 ? 'invalid' : 'transient';
}

/** Host-neutral source for authenticated Supabase session tokens. */
export interface AuthTokenProvider {
  whenReady(): Promise<void>;
  ensureFreshToken(forceRefresh?: boolean): Promise<string | null>;
  getSessionTokens(): Promise<SessionTokens | null>;
  /** Classify the stored session while guarding against replacement races. */
  getStoredSessionState(): Promise<StoredSessionState>;
  /**
   * The account label (email) from the stored session, without attempting a
   * token refresh. Returns null when no session is stored or the stored data
   * is unreadable.
   */
  getStoredAccountLabel(): Promise<string | null>;
  /**
   * Whether the stored session's access token is within the provider's refresh
   * threshold, judged from the last session the provider read or wrote.
   * Synchronous and in-memory, so it is safe before every model invocation;
   * false when no session expiry has been observed.
   */
  isTokenExpiringSoon(): boolean;
  /**
   * Classification of the most recent refresh failure. `invalid` means the
   * credential was authoritatively rejected; `transient` covers transport and
   * service failures for which reconnecting would be premature.
   */
  getLastRefreshFailure(): SessionRefreshFailure | null;
}
