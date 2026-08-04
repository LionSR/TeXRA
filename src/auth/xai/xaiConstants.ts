/**
 * Constants for the experimental "Sign in with Grok" (xAI SuperGrok) OAuth flow.
 *
 * Rides a public Grok-CLI OAuth client registration. xAI can change or revoke
 * that registration without notice — never present this as an xAI-sanctioned
 * TeXRA integration. Keep EVERY magic value here so an upstream change is a
 * one-file edit.
 *
 * Sources (read from source, not blog posts):
 * - OpenCode: packages/opencode/src/plugin/xai.ts (anomalyco/opencode)
 * - hermes-agent PR #26534 (Grok-CLI client id registration notes in OpenCode)
 */

/** Borrowed OAuth client id (Grok CLI desktop registration). */
export const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

/** xAI auth issuer base. */
const XAI_ISSUER = 'https://auth.x.ai';

/** OAuth authorize endpoint. */
export const XAI_AUTHORIZE_URL = `${XAI_ISSUER}/oauth2/authorize`;

/** OAuth token endpoint (code exchange + refresh + device poll). */
export const XAI_TOKEN_URL = `${XAI_ISSUER}/oauth2/token`;

/** RFC 8628 device authorization endpoint. */
export const XAI_DEVICE_AUTHORIZATION_URL = `${XAI_ISSUER}/oauth2/device/code`;

/**
 * Loopback redirect — the Grok-CLI client registration pins host:port:path.
 * Do NOT pick another port; xAI rejects non-registered redirect_uris.
 */
const XAI_CALLBACK_HOST = '127.0.0.1';
export const XAI_CALLBACK_PORT = 56121;
export const XAI_CALLBACK_PATH = '/callback';

/** Build the loopback redirect URI (only one port is registered). */
export function xaiRedirectUri(): string {
  return `http://${XAI_CALLBACK_HOST}:${XAI_CALLBACK_PORT}${XAI_CALLBACK_PATH}`;
}

/** OAuth scopes requested at authorize / device time. */
export const XAI_SCOPE =
  'openid profile email offline_access grok-cli:access api:access';

/**
 * Attribution referrer on the authorize URL. Our own string — do not
 * impersonate `opencode` or `grok-cli`.
 */
export const XAI_REFERRER = 'texra';

/**
 * `plan=generic` opts the consent screen into xAI's generic OAuth plan tier;
 * without it, accounts.x.ai rejects loopback OAuth from non-allowlisted clients.
 */
export const XAI_PLAN = 'generic';

/** RFC 8628 device-code grant type. */
export const XAI_DEVICE_CODE_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:device_code';

/**
 * Secret-storage key for the persisted OAuth token bundle. Outside the
 * `apiKey.<provider>` namespace so it never collides with API-key scans.
 */
export const XAI_SESSION_SECRET_KEY = 'auth.xai-grok';

/**
 * Refresh proactively when within this window of expiry (matches Codex /
 * ChatGPT's 5-minute buffer; OpenCode uses 2 minutes).
 */
export const XAI_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Fallback access-token lifetime when the token response omits expires_in. */
export const XAI_DEFAULT_EXPIRES_IN_SEC = 3600;

/** Default device-code poll interval when the endpoint omits `interval`. */
export const XAI_DEVICE_DEFAULT_INTERVAL_SEC = 5;

/** Default device-code lifetime when the endpoint omits `expires_in`. */
export const XAI_DEVICE_DEFAULT_EXPIRES_SEC = 5 * 60;

/** RFC 8628 slow_down increment (seconds). */
export const XAI_DEVICE_SLOW_DOWN_INCREMENT_SEC = 5;
