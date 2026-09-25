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
