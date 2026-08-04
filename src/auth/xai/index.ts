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
export {
  XAI_CALLBACK_PATH,
  XAI_CALLBACK_PORT,
  XAI_CLIENT_ID,
  XAI_REFERRER,
  XAI_SESSION_SECRET_KEY,
  xaiRedirectUri,
} from './xaiConstants';
export {
  generateCodeVerifier,
  computeCodeChallenge,
  generatePkcePair,
  generateOAuthState,
} from '../oauth/pkce';
export {
  accessTokenIsExpiring,
  decodeXaiJwtClaims,
  extractXaiClaims,
} from './xaiJwt';
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
  type XaiSessionStatus,
  type XaiAuthorizeRequest,
} from './XaiSessionCoordinator';
export {
  xaiCoordinator,
  resetXaiCoordinator,
  getXaiStatus,
  isXaiSessionRoutable,
} from './xaiAuthAccess';
export { loginWithLoopback } from './xaiLoopbackLogin';
export { loginWithDeviceCode } from './xaiDeviceLogin';
