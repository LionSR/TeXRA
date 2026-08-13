/**
 * Experimental "Sign in with Grok" (xAI SuperGrok subscription) OAuth session.
 *
 * Public surface for hosts (CLI/extension/desktop login commands) and the xAI
 * model handler. Rides a public Grok-CLI OAuth client registration — opt-in,
 * off by default, personal use only.
 *
 * The "prefer my subscription" switches are NOT here: they are model-selection
 * preferences, owned by `@model/xai/xaiPreference` so the model layer can
 * read them without depending on this OAuth machinery.
 */
export { decodeXaiJwtClaims } from './xaiJwt';
export {
  XaiAuthError,
  formatXaiAuthUnavailableMessage,
  xaiAccountLabel,
  type XaiSession,
  type XaiTokenResponse,
} from './xaiSessionTypes';
export {
  XaiSessionCoordinator,
  type XaiSessionStorage,
  type XaiOAuthClient,
} from './XaiSessionCoordinator';
export { xaiCoordinator, getXaiStatus } from './xaiAuthAccess';
export { loginWithLoopback } from './xaiLoopbackLogin';
export { loginWithDeviceCode } from './xaiDeviceLogin';
