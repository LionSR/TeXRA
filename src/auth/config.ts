/**
 * Supabase configuration for TeXRA authentication and remote agents.
 *
 * These credentials are for TeXRA's official Supabase backend.
 * Users authenticate to TeXRA's service, not their own Supabase instance.
 *
 * Similar to how GitHub Copilot works - users sign in to the official service.
 */
import { z } from 'zod';

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
 * Edge function URL for custom token refresh.
 * Used for sessions minted by the auth edge functions rather than by a
 * standard Supabase OAuth callback.
 */
export const GITHUB_TOKEN_REFRESH_URL = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/auth-github/refresh`;

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
 * The editor scheme and extension id ride as PATH segments
 * (/auth-bridge/<scheme>/<id>) so redirect_to carries no '?' that an OAuth
 * round-trip could mangle. The Supabase Redirect URLs allow-list entry is the
 * globstar https://remote.texra.ai/functions/v1/auth-bridge** (it must span the
 * '/' and '.' in the path, which a single '*' cannot).
 */
export const AUTH_BRIDGE_URL = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/auth-bridge`;

/**
 * Base URL for the CI relay token management edge function
 * (texra setup-token / texra auth token).
 */
export const RELAY_TOKENS_BASE_URL = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/relay-tokens`;

/**
 * The relay's tier-config endpoint under a given Supabase base URL. TierService
 * resolves it against its injected base URL; everything else uses the constant.
 */
export function relayTierConfigUrl(baseUrl: string): string {
  return `${baseUrl}/functions/v1/relay/tier-config`;
}

/** Public URL of the relay's tier-config endpoint. */
export const RELAY_TIER_CONFIG_URL = relayTierConfigUrl(SUPABASE_CONFIG.url);

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
 * Single source of truth for tier values used in server-side API key access.
 *
 * The relay edge function cannot import this client-side module. Keep the
 * duplicated relay tier constants in sync; parity is enforced by
 * src/test-kernel/supabase/RelaySharedConfigParity.vitest.ts.
 *
 * The schema enum order is: 'free', 'Max', 'Ultra' (ascending privilege).
 */
export const UserTierSchema = z.enum(['free', 'Max', 'Ultra']);
export type UserTier = z.infer<typeof UserTierSchema>;

/** Tier constants derived from the schema - use these instead of string literals. */
export const FREE_TIER: UserTier = 'free';
export const MAX_TIER: UserTier = 'Max';
export const ULTRA_TIER: UserTier = 'Ultra';

/** Cache TTL for server-side key access and tier config (5 minutes). */
export const SERVER_SIDE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Monthly relay spending limits in USD.
 *
 * The relay edge function duplicates these values in its Deno module graph;
 * src/test-kernel/supabase/RelaySharedConfigParity.vitest.ts enforces parity.
 */
const RELAY_TIER_SPENDING_LIMITS: Record<UserTier, number> = {
  [FREE_TIER]: 10,
  [MAX_TIER]: 50,
  [ULTRA_TIER]: 300,
};

export function getRelaySpendingLimit(tier: string | undefined): number {
  // An absent tier denotes an unauthenticated/free request. A present but
  // malformed tier is accounting data corruption and must fail validation.
  const parsedTier = UserTierSchema.prefault(FREE_TIER).parse(tier);
  return RELAY_TIER_SPENDING_LIMITS[parsedTier];
}

/**
 * Check if Supabase is configured.
 * Returns false if using placeholder values.
 */
export function isSupabaseConfigured(): boolean {
  return (
    !SUPABASE_CONFIG.url.includes('placeholder') &&
    SUPABASE_CONFIG.publicKey !== 'placeholder-public-key'
  );
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
 * Note: This returns the base URI. Use getExternalAuthCallbackInfo() for
 * the environment-appropriate callback URL (handles Codespaces, Remote SSH, etc.)
 */
export function getAuthCallbackUri(uriScheme: string): string {
  return `${uriScheme}://${getExtensionId()}/auth-callback`;
}

/**
 * Result of resolving the external auth callback URI.
 * In Codespaces, VS Code adds a ?state= routing token to the URL that must be
 * preserved on redirect_to for the callback to route back into the editor, so
 * the OAuth flow uses this full URL (token included) as its redirectTo.
 */
export interface ExternalAuthCallbackInfo {
  /** Full callback URL, including any VS Code ?state= routing token. */
  fullUrl: string;
}

export type ExternalAuthCallbackResolver =
  () => Promise<ExternalAuthCallbackInfo>;

let externalAuthCallbackResolver: ExternalAuthCallbackResolver | null = null;

/**
 * Register the host-specific OAuth callback adapter.
 *
 * VS Code must route web auth redirects through env.asExternalUri(), but shared
 * auth config also loads in Electron. Keeping the adapter host-owned prevents
 * Electron bundles from carrying a runtime dependency on the VS Code module.
 */
export function setExternalAuthCallbackResolver(
  resolver: ExternalAuthCallbackResolver | null,
): void {
  externalAuthCallbackResolver = resolver;
}

/**
 * Get the external auth callback URI with parsed components.
 * Uses the host-provided adapter to handle different environments:
 * - Desktop VS Code: returns vscode://texra-ai.texra/auth-callback
 * - Cursor: returns cursor://texra-ai.texra/auth-callback
 * - Codespaces: returns https://*.github.dev/extension-auth-callback
 * - Remote SSH: handles port forwarding automatically
 *
 * In Codespaces, VS Code generates a state parameter that MUST be preserved
 * and passed through the OAuth flow for the callback routing to work.
 */
export async function getExternalAuthCallbackInfo(): Promise<ExternalAuthCallbackInfo> {
  if (!externalAuthCallbackResolver) {
    return { fullUrl: getAuthCallbackUri('vscode') };
  }
  return externalAuthCallbackResolver();
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
