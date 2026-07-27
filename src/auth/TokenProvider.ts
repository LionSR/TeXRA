export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

/** Host-neutral source for authenticated Supabase session tokens. */
export interface AuthTokenProvider {
  whenReady(): Promise<void>;
  ensureFreshToken(forceRefresh?: boolean): Promise<string | null>;
  getSessionTokens(): Promise<SessionTokens | null>;
  /** Whether a previously-stored session exists in storage (no refresh). */
  hasStoredSession(): Promise<boolean>;
  /**
   * The account label (email) from the stored session, without attempting a
   * token refresh. Returns null when no session is stored or the stored data
   * is unreadable.
   */
  getStoredAccountLabel(): Promise<string | null>;
}
