export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

/** Host-neutral source for authenticated Supabase session tokens. */
export interface AuthTokenProvider {
  whenReady(): Promise<void>;
  ensureFreshToken(forceRefresh?: boolean): Promise<string | null>;
  getSessionTokens(): Promise<SessionTokens | null>;
}
