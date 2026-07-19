/**
 * Experimental "Sign in with ChatGPT" (Codex subscription) auth.
 *
 * Public surface for hosts (CLI/extension/desktop login commands), the Codex
 * model handler, and the model-availability gate. Rides an UNOFFICIAL OpenAI
 * endpoint + borrowed client id — opt-in, off by default, personal use only.
 */
export {
  CODEX_ACCOUNT_ID_HEADER,
  CODEX_BACKEND_BASE_URL,
  CODEX_BETA_HEADER,
  CODEX_BETA_VALUE,
  CODEX_CALLBACK_PATH,
  CODEX_ORIGINATOR,
  CODEX_ORIGINATOR_HEADER,
  CODEX_PREFER_SUBSCRIPTION_KEY,
  CODEX_SESSION_SECRET_KEY,
} from './codexConstants';
export {
  generateCodeVerifier,
  computeCodeChallenge,
  generatePkcePair,
  generateOAuthState,
} from './codexPkce';
export { extractCodexClaims } from './codexJwt';
export {
  CodexAuthError,
  formatCodexAuthUnavailableMessage,
  type CodexSession,
  type CodexTokenResponse,
} from './codexSessionTypes';
export {
  CodexSessionCoordinator,
  type CodexSessionStorage,
  type CodexOAuthClient,
  type CodexSessionStatus,
  type CodexAuthorizeRequest,
} from './CodexSessionCoordinator';
export {
  codexCoordinator,
  resetCodexCoordinator,
  getCodexStatus,
  getChatGptAuthStatus,
  isCodexSessionRoutable,
  isCodexSignedIn,
} from './codexAuthAccess';
export {
  isPreferCodexSubscription,
  isCodexSubscriptionToolUseOnly,
  setPreferCodexSubscription,
  setCodexSubscriptionToolUseOnly,
  type CodexSubscriptionPreferenceUpdate,
} from './codexPreference';
export { loginWithLoopback } from './codexLoopbackLogin';
export { loginWithDeviceCode } from './codexDeviceLogin';
