/**
 * Constants for the experimental "Sign in with ChatGPT" (Codex subscription)
 * flow.
 *
 * This rides an UNOFFICIAL OpenAI endpoint and a borrowed OAuth client id (the
 * Codex CLI's). It can break or be revoked without notice and must never be
 * presented as an OpenAI-sanctioned integration. Keep EVERY magic value here so
 * an upstream OpenAI change is a one-file edit.
 *
 * Sources (read directly from source, not blog posts):
 * - OpenCode native plugin: opencode/src/plugin/openai/codex.ts
 * - OpenCode auth plugin: numman-ali/opencode-openai-codex-auth lib/auth/auth.ts
 * - Device flow: tumf/opencode-openai-device-auth src/index.ts
 * - Zed: crates/language_models/src/provider/openai_subscribed.rs
 */

/** Borrowed OAuth client id (the Codex CLI's own registration). */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** OpenAI auth issuer. */
const CODEX_ISSUER = 'https://auth.openai.com';

/** OAuth authorize endpoint. */
export const CODEX_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;

/** OAuth token endpoint (code exchange + refresh). */
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;

/** Device-code endpoints (headless / SSH / non-TTY login). */
export const CODEX_DEVICE_USERCODE_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`;
export const CODEX_DEVICE_TOKEN_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`;
/** Where the user enters the one-time device code. */
export const CODEX_DEVICE_VERIFICATION_URL = `${CODEX_ISSUER}/codex/device`;
/** Redirect URI used by the device-code token exchange. */
export const CODEX_DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;

/**
 * Loopback redirect allow-list. The borrowed client id ONLY permits
 * `http://localhost:1455/auth/callback` and `http://localhost:1457/auth/callback`;
 * any other host/port/path makes auth.openai.com reject the authorize request
 * with a generic `unknown_error` before redirecting back. Do NOT pick your own
 * port. (Keep in sync with codex-rs/login/src/server.rs in openai/codex.)
 */
const CODEX_CALLBACK_HOST = 'localhost';
export const CODEX_CALLBACK_PORT = 1455;
export const CODEX_CALLBACK_FALLBACK_PORT = 1457;
export const CODEX_CALLBACK_PATH = '/auth/callback';

/** Build the loopback redirect URI for a given port. */
export function codexRedirectUri(port: number): string {
  return `http://${CODEX_CALLBACK_HOST}:${port}${CODEX_CALLBACK_PATH}`;
}

/** OAuth scopes requested at authorize time. */
export const CODEX_SCOPE = 'openid profile email offline_access';

/**
 * Our OWN originator string. Deliberately NOT `codex_cli_rs` — we must not
 * impersonate the Codex CLI. Sent both as an authorize-URL param and a request
 * header.
 */
export const CODEX_ORIGINATOR = 'texra';

/**
 * Codex backend base URL. Already includes the `codex` path segment, so the
 * OpenAI SDK's `/responses` suffix yields `.../codex/responses`.
 */
export const CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/** Non-auth request headers for the Codex backend. */
export const CODEX_ACCOUNT_ID_HEADER = 'chatgpt-account-id';
export const CODEX_ORIGINATOR_HEADER = 'originator';
export const CODEX_BETA_HEADER = 'openai-beta';
export const CODEX_BETA_VALUE = 'responses=experimental';

/** JWT claim namespace holding the ChatGPT account id. */
export const CODEX_JWT_AUTH_CLAIM = 'https://api.openai.com/auth';

/**
 * Secret-storage key for the persisted OAuth token bundle. Deliberately OUTSIDE
 * the `apiKey.<provider>` namespace so it never collides with the api-key scans
 * over API_KEY_PROVIDER_IDS, and so the Codex credential is never treated as an
 * api key.
 */
export const CODEX_SESSION_SECRET_KEY = 'auth.chatgpt-codex';

/**
 * Refresh proactively when within this window of expiry (matches Codex CLI /
 * Zed's 5-minute buffer).
 */
export const CODEX_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
