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
 * Edge function URL for GitHub token exchange.
 * Used in VS Code web/Codespaces where standard OAuth callbacks don't work.
 */
export const GITHUB_TOKEN_EXCHANGE_URL = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/auth-github/exchange`;

/**
 * Edge function URL for custom token refresh.
 * Used for sessions created via VS Code GitHub auth (not standard Supabase OAuth).
 */
export const GITHUB_TOKEN_REFRESH_URL = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/auth-github/refresh`;

/**
 * Base URL for the device-code (RFC 8628 style) sign-in edge function.
 * Used by headless terminals where a loopback OAuth callback can't work.
 */
export const DEVICE_AUTH_BASE_URL = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/auth-device`;

/**
 * URL of the OAuth bridge edge function (the auth-bridge HTML page).
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

/** Public URL of the relay's tier-config endpoint. */
export const RELAY_TIER_CONFIG_URL = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/relay/tier-config`;

/**
 * Supported OAuth providers for TeXRA authentication.
 * Users can choose between GitHub and Google during sign-in.
 */
export const OAUTH_PROVIDERS = ['github', 'google'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/**
 * Return whether a string is one of TeXRA's supported OAuth providers.
 */
export function isOAuthProvider(
  value: string | undefined,
): value is OAuthProvider {
  return (
    value !== undefined && OAUTH_PROVIDERS.includes(value as OAuthProvider)
  );
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
  const parsedTier = UserTierSchema.catch(FREE_TIER).parse(tier);
  return RELAY_TIER_SPENDING_LIMITS[parsedTier];
}
