/**
 * Supabase configuration for TeXRA authentication and remote agents.
 *
 * These credentials are for TeXRA's official Supabase backend.
 * Users authenticate to TeXRA's service, not their own Supabase instance.
 *
 * Similar to how GitHub Copilot works - users sign in to the official service.
 */
/**
 * Supabase configuration interface.
 */
export interface SupabaseConfig {
  /** Supabase project URL. */
  url: string;
  /**
   * Supabase public key - safe to include in client code.
   * Can be either:
   * - Publishable key (recommended): starts with `sb_publishable_...`
   * - Anon key (legacy): JWT starting with `eyJ...`
   */
  publicKey: string;
  /** Edge function URL for fetching remote agent configurations. */
  edgeFunctionUrl: string;
}

/** Custom domain for Supabase-backed remote services. */
export const SUPABASE_CUSTOM_DOMAIN = 'remote.texra.ai';

export const SUPABASE_CONFIG: SupabaseConfig = {
  // Production Supabase URL via custom domain
  url: `https://${SUPABASE_CUSTOM_DOMAIN}`,

  // Production public key - safe to include in client code
  publicKey: 'sb_publishable_DUIDjtxk12ZYYncrVUfwOw_xWQYsSvw',

  // Edge function URL via custom domain
  edgeFunctionUrl: `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/get-agent-config`,
};

/**
 * Base URL for the device-code (RFC 8628 style) sign-in edge function.
 * Used by headless terminals where a loopback OAuth callback can't work.
 */
export const DEVICE_AUTH_BASE_URL = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/auth-device`;

/**
 * URL of the OAuth bridge edge function.
 * Desktop browser-OAuth redirects GoTrue here instead of straight to a raw
 * vscode:// deep link, so browsers that drop custom-scheme server redirects
 * (Firefox on Linux) can finish sign-in: the page reconstructs the editor
 * deep link from the URL and offers a real-click "Open in your editor" button.
 * With PKCE the page only ever carries a one-time ?code= (no tokens).
 *
 * The editor scheme, extension id, and callback nonce ride as PATH segments
 * (/auth-bridge/<scheme>/<id>/<nonce>) so redirect_to carries no '?'
 * that an OAuth round-trip could mangle. The Redirect URLs allow-list entry is the
 * globstar https://remote.texra.ai/functions/v1/auth-bridge** (it must span the
 * '/' and '.' in the path, which a single '*' cannot).
 */
export const AUTH_BRIDGE_URL = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/auth-bridge`;

/**
 * Supported OAuth providers for TeXRA authentication.
 * Users can choose between GitHub and Google during sign-in.
 */
export const OAUTH_PROVIDERS = ['github', 'google'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** Display names every host's sign-in picker shows for {@link OAUTH_PROVIDERS}. */
export const OAUTH_PROVIDER_LABELS = {
  github: 'GitHub',
  google: 'Google',
} as const satisfies Record<OAuthProvider, string>;

/**
 * Return whether a string is one of TeXRA's supported OAuth providers.
 */
export function isOAuthProvider(
  value: string | undefined,
): value is OAuthProvider {
  return OAUTH_PROVIDERS.includes(value as OAuthProvider);
}

/**
 * Default OAuth provider to use.
 * Users can choose during sign-in if multiple are configured in Supabase.
 */
export const DEFAULT_OAUTH_PROVIDER: OAuthProvider = 'github';

/**
 * VS Code extension ID for OAuth redirects.
 * Format: publisher.extensionName (from package.json)
 *
 * This is the default/fallback value. At runtime, use getExtensionId()
 * which returns the actual extension ID from context if available.
 */
const EXTENSION_ID = 'texra-ai.texra';

/**
 * Runtime extension ID set during activation.
 * This ensures the redirect URI matches the actual extension ID,
 * which is critical for OAuth flows.
 */
let runtimeExtensionId: string | null = null;

/**
 * Set the runtime extension ID from the extension context.
 * Should be called during extension activation with context.extension.id
 */
export function setRuntimeExtensionId(id: string): void {
  runtimeExtensionId = id;
}

/**
 * Get the extension ID for OAuth redirects.
 * Returns the runtime ID if set, otherwise falls back to the default.
 */
export function getExtensionId(): string {
  return runtimeExtensionId ?? EXTENSION_ID;
}

/**
 * Get the OAuth callback URI for redirects.
 * Used by the OAuth flow.
 *
 * Note: This returns the base URI. Hosts that must route web redirects through
 * their own environment (VS Code's `env.asExternalUri()` for Codespaces and
 * Remote SSH) wrap it themselves — see `SupabaseAuthProvider.buildOAuthOptions`.
 */
export function getAuthCallbackUri(uriScheme: string): string {
  return `${uriScheme}://${getExtensionId()}/auth-callback`;
}

/**
 * How long an interactive browser sign-in may take before the host stops
 * waiting for the callback (10 minutes). Shared by every loopback/deeplink
 * wait so one abandoned sign-in behaves the same in every host. Generous on
 * purpose: an OAuth round-trip with 2FA and account switching outlasts a
 * couple of minutes, and each flow is user-cancellable, so a long deadline
 * only delays the failure message for attempts nobody is waiting on.
 *
 * Device-code flows do not use this: RFC 8628 makes the server's `expires_in`
 * authoritative there.
 */
export const AUTH_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

/** Refresh token proactively if it expires within this threshold (30 minutes). */
export const TOKEN_REFRESH_THRESHOLD_MS = 30 * 60 * 1000;

/** Key the stored Supabase session takes in the host's secret storage. */
export const SUPABASE_SESSION_KEY = 'texra.supabase.session';

/**
 * GoTrue's own storage key. Pinned rather than left to the default derived
 * from the URL host so the client's storage can tell the session slot (this
 * exact key, kept in memory) from the PKCE flow state it derives from it
 * (suffixed keys, persisted so a callback can land in any window).
 */
export const SUPABASE_GOTRUE_STORAGE_KEY = 'texra.supabase.gotrue';
