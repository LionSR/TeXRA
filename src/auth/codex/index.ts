/**
 * Experimental "Sign in with ChatGPT" (Codex subscription) auth.
 *
 * Public surface for hosts (CLI/extension/desktop login commands), the Codex
 * model handler, and the model-availability gate. Rides an UNOFFICIAL OpenAI
 * endpoint + borrowed client id — opt-in, off by default, personal use only.
 */
export * from './codexConstants';
export {
  generateCodeVerifier,
  computeCodeChallenge,
  generatePkcePair,
  generateOAuthState,
  type PkcePair,
} from './codexPkce';
export {
  decodeJwtPayload,
  extractCodexClaims,
  type CodexJwtClaims,
} from './codexJwt';
export {
  CodexAuthError,
  formatCodexAuthUnavailableMessage,
  CodexSessionSchema,
  type CodexSession,
  type CodexTokenResponse,
  type CodexDeviceUserCode,
  type CodexDeviceToken,
  type CodexAuthErrorKind,
} from './codexSessionTypes';
export {
  exchangeAuthorizationCode,
  refreshTokens,
  requestDeviceUserCode,
  pollDeviceToken,
  deviceUserCode,
} from './codexOAuthClient';
export {
  CodexSessionCoordinator,
  type CodexSessionCoordinatorInit,
  type CodexSessionStorage,
  type CodexOAuthClient,
  type CodexSessionStatus,
  type CodexAuthorizeRequest,
  type CodexLogger,
} from './CodexSessionCoordinator';
export {
  createCodexAuthCoordinator,
  type CodexAuthCoordinatorInit,
  type CodexSecretStore,
} from './CodexAuthCoordinator';
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
export {
  resolveCodexSubscriptionCapabilities,
  resolveCodexSubscriptionCapabilitiesForAgentCategory,
} from './codexRouting';
export { isCodexSubscriptionActive } from './codexActive';
export {
  loginWithLoopback,
  type CodexLoopbackLoginOptions,
} from './codexLoopbackLogin';
export {
  loginWithDeviceCode,
  type CodexDeviceLoginOptions,
  type CodexDevicePrompt,
} from './codexDeviceLogin';
