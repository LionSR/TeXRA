/**
 * Supabase configuration for TeXRA authentication and remote agents.
 *
 * These credentials are for TeXRA's official Supabase backend.
 * Users authenticate to TeXRA's service, not their own Supabase instance.
 *
 * Similar to how GitHub Copilot works - users sign in to the official service.
 */

/**
 * Supabase configuration interface
 */
export interface SupabaseConfig {
  /** Supabase project URL */
  url: string;
  /**
   * Supabase public key - safe to include in client code.
   * Can be either:
   * - Publishable key (recommended): starts with `sb_publishable_...`
   * - Anon key (legacy): JWT starting with `eyJ...`
   */
  publicKey: string;
  /** Edge function URL for fetching remote agent configurations */
  edgeFunctionUrl: string;
}

/**
 * Official TeXRA Supabase configuration.
 *
 * These are the production credentials for TeXRA's official Supabase backend.
 * The public key (anon or publishable) is safe to include in client code.
 * Row Level Security (RLS) policies protect data access, not the key.
 */

export const SUPABASE_PROJECT_ID = 'jntubmcgbhwtcktubelv';

/** Custom domain for Supabase (remote agent access) */
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
 * Check if Supabase is configured.
 * Returns false if using placeholder values.
 */
export function isSupabaseConfigured(): boolean {
  return (
    SUPABASE_CONFIG.url !== `placeholder-url` &&
    SUPABASE_CONFIG.publicKey !== 'placeholder-public-key' &&
    !SUPABASE_CONFIG.url.includes('placeholder')
  );
}

/**
 * Supported OAuth providers for TeXRA authentication.
 * All providers are supported - no need for user configuration.
 */
export const OAUTH_PROVIDERS = ['github', 'google', 'gitlab'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/**
 * Default OAuth provider to use.
 * Users can choose during sign-in if multiple are configured in Supabase.
 */
export const DEFAULT_OAUTH_PROVIDER: OAuthProvider = 'github';

/**
 * VS Code extension ID for OAuth redirects.
 * Format: publisher.extensionName (from package.json)
 */
export const EXTENSION_ID = 'texra-ai.texra';
