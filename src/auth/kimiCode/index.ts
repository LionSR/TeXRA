/**
 * Experimental "Sign in with Kimi Code" (Moonshot coding-subscription) auth.
 *
 * Public surface for hosts (CLI/extension/desktop login commands), the Kimi
 * Code model handler, and the model-availability gate. Rides an UNOFFICIAL
 * flow with a borrowed client id (kimi-cli's own registration) — opt-in, off
 * by default, personal use only. The Kimi Code console API key remains the
 * documented alternative for the same endpoint.
 */
export * from './kimiCodeConstants';
export {
  KimiCodeAuthError,
  formatKimiCodeAuthUnavailableMessage,
  type KimiCodeSession,
  type KimiCodeTokenResponse,
} from './kimiCodeSessionTypes';
export {
  requestDeviceUserCode,
  pollDeviceToken,
  refreshTokens,
} from './kimiCodeOAuthClient';
export { kimiCodeClientHeaders } from './kimiCodeDeviceIdentity';
export {
  KimiCodeSessionCoordinator,
  type KimiCodeSessionStorage,
  type KimiCodeOAuthRefreshClient,
} from './KimiCodeSessionCoordinator';
export {
  kimiCodeCoordinator,
  getKimiCodeAuthStatus,
  isKimiCodeSignedIn,
} from './kimiCodeAuthAccess';
export {
  isPreferKimiCodeSubscription,
  isKimiCodeSubscriptionToolUseOnly,
  setPreferKimiCodeSubscription,
  setKimiCodeSubscriptionToolUseOnly,
  type KimiCodeSubscriptionPreferenceUpdate,
} from './kimiCodePreference';
export { loginWithKimiCodeDeviceCode } from './kimiCodeDeviceLogin';
