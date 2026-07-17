/**
 * Constants for the experimental "Sign in with Kimi Code" subscription flow.
 *
 * Values are reverse-engineered from the Kimi Code CLI distribution
 * (`@moonshot-ai/kimi-code`). The flow can break or be revoked without notice
 * and must be treated as experimental / opt-in only.
 */

/** Kimi Code OAuth issuer. */
export const KIMI_CODE_OAUTH_HOST = 'https://auth.kimi.com';

/**
 * Borrowed OAuth client id (the Kimi Code CLI's own registration).
 * Keep this with the other magic values so an upstream change is a one-file edit.
 */
export const KIMI_CODE_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

/** Kimi Code managed API base URL. */
export const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';

/**
 * Client version reported as `X-Msh-Version`. A fixed constant (not the host
 * app version): no host-neutral version port exists, and the backend only
 * needs a plausible client fingerprint, kept here so an upstream policy change
 * stays a one-file edit.
 */
export const KIMI_CODE_CLIENT_VERSION = '1.0.0';

/** Device-code authorization endpoint. */
export const KIMI_CODE_DEVICE_AUTHORIZATION_URL = `${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`;

/** OAuth token endpoint (device-code exchange + refresh). */
export const KIMI_CODE_TOKEN_URL = `${KIMI_CODE_OAUTH_HOST}/api/oauth/token`;

/** Default interval between device-token polls, in seconds. */
export const KIMI_CODE_DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** Default wall-clock budget for a device-code login, in milliseconds. */
export const KIMI_CODE_DEVICE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Secret-storage key for the persisted OAuth token bundle. Deliberately OUTSIDE
 * the `apiKey.<provider>` namespace so it never collides with API-key scans.
 */
export const KIMI_CODE_SESSION_SECRET_KEY = 'auth.kimi-code';

/** Refresh proactively when within this window of expiry. */
export const KIMI_CODE_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Config key for the "prefer my Kimi Code subscription" switch (off by default). */
export const KIMI_CODE_PREFER_SUBSCRIPTION_KEY =
  'texra.kimiCode.preferSubscription';

/**
 * Config key for the "subscription for tool-use agents only" switch (off by
 * default). When on, only tool-use agents route through the Kimi Code
 * subscription; workflow agents fall back to the user's API key / relay.
 */
export const KIMI_CODE_SUBSCRIPTION_TOOL_USE_ONLY_KEY =
  'texra.kimiCode.subscriptionToolUseOnly';
