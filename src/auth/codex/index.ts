/**
 * Experimental "Sign in with ChatGPT" (Codex subscription) OAuth session.
 *
 * Public surface for hosts (CLI/extension/desktop login commands) and the Codex
 * model handler. Rides an UNOFFICIAL OpenAI endpoint + borrowed client id —
 * opt-in, off by default, personal use only.
 *
 * The "prefer my subscription" switches are NOT here: they are model-selection
 * preferences, owned by `@model/codex/codexPreference` so the model layer can
 * read them without depending on this OAuth machinery.
 */
export {
  CODEX_ACCOUNT_ID_HEADER,
  CODEX_BACKEND_BASE_URL,
  CODEX_BETA_HEADER,
  CODEX_BETA_VALUE,
  CODEX_CALLBACK_PATH,
  CODEX_ORIGINATOR,
  CODEX_ORIGINATOR_HEADER,
  CODEX_SESSION_SECRET_KEY,
} from './codexConstants';
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
} from './CodexSessionCoordinator';
export {
  codexCoordinator,
  resetCodexCoordinator,
  getCodexStatus,
  isCodexSessionRoutable,
} from './codexAuthAccess';
export { loginWithLoopback } from './codexLoopbackLogin';
export { loginWithDeviceCode } from './codexDeviceLogin';
