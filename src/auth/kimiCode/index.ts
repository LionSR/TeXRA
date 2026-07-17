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
  KimiCodeSessionSchema,
  KimiCodeTokenResponseSchema,
  KimiCodeDeviceUserCodeSchema,
  type KimiCodeSession,
  type KimiCodeTokenResponse,
  type KimiCodeDeviceUserCode,
  type KimiCodeAuthErrorKind,
} from './kimiCodeSessionTypes';
export {
  requestDeviceUserCode,
  pollDeviceToken,
  refreshTokens,
  type KimiCodePollResult,
} from './kimiCodeOAuthClient';
export {
  getKimiCodeDeviceId,
  kimiCodeClientHeaders,
} from './kimiCodeDeviceIdentity';
export {
  KimiCodeSessionCoordinator,
  type KimiCodeSessionCoordinatorInit,
  type KimiCodeSessionStorage,
  type KimiCodeOAuthRefreshClient,
  type KimiCodeSessionStatus,
  type KimiCodeLogger,
} from './KimiCodeSessionCoordinator';
export {
  createKimiCodeAuthCoordinator,
  type KimiCodeAuthCoordinatorInit,
  type KimiCodeSecretStore,
} from './KimiCodeAuthCoordinator';
export {
  kimiCodeCoordinator,
  resetKimiCodeCoordinator,
  getKimiCodeStatus,
  getKimiCodeAuthStatus,
  isKimiCodeSessionRoutable,
  isKimiCodeSignedIn,
} from './kimiCodeAuthAccess';
export {
  isPreferKimiCodeSubscription,
  isKimiCodeSubscriptionToolUseOnly,
  setPreferKimiCodeSubscription,
  setKimiCodeSubscriptionToolUseOnly,
  type KimiCodeSubscriptionPreferenceUpdate,
} from './kimiCodePreference';
export {
  loginWithKimiCodeDeviceCode,
  type KimiCodeDeviceLoginOptions,
  type KimiCodeDevicePrompt,
} from './kimiCodeDeviceLogin';
