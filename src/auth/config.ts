/**
 * Supabase configuration for TeXRA authentication and remote agents.
 *
 * These credentials are for TeXRA's official Supabase backend.
 * Users authenticate to TeXRA's service, not their own Supabase instance.
 *
 * Similar to how GitHub Copilot works - users sign in to the official service.
 *
 * IMPORTANT: Update these constants before building for production.
 * These are placeholders for development. Set real values before release.
 */

/**
 * Supabase configuration interface
 */
export interface SupabaseConfig {
  /** Supabase project URL */
  url: string;
  /** Supabase anonymous (public) key - safe to include in client code */
  anonKey: string;
  /** Edge function URL for fetching remote agent configurations */
  edgeFunctionUrl: string;
}

/**
 * Official TeXRA Supabase configuration.
 *
 * IMPORTANT: These should be set during build/release.
 * For development, you can override via environment variables:
 * - TEXRA_SUPABASE_URL
 * - TEXRA_SUPABASE_ANON_KEY
 */

export const SUPABASE_PROJECT_ID = 'jntubmcgbhwtcktubelv';

export const SUPABASE_CONFIG: SupabaseConfig = {
  // TODO: Replace with your actual Supabase project URL before release
  url:
    process.env.TEXRA_SUPABASE_URL ||
    `https://${SUPABASE_PROJECT_ID}.supabase.co`,

  // TODO: Replace with your actual Supabase anon key before release
  // Note: The anon key is public and safe to include in client code
  anonKey: 'placeholder-anon-key',

  // Edge function URL
  edgeFunctionUrl:
    process.env.TEXRA_SUPABASE_EDGE_FUNCTION_URL ||
    `https://${SUPABASE_PROJECT_ID}.supabase.co/functions/v1/get-agent-config`,
};

/**
 * Check if Supabase is configured.
 * Returns false if using placeholder values.
 */
export function isSupabaseConfigured(): boolean {
  return (
    SUPABASE_CONFIG.url !== `https://${SUPABASE_PROJECT_ID}.supabase.co` &&
    SUPABASE_CONFIG.anonKey !== 'placeholder-anon-key' &&
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
