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
 * Users can choose between GitHub and Google during sign-in.
 */
export const OAUTH_PROVIDERS = ['github', 'google'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

// ============================================================================
// User Groups & Permissions
// ============================================================================

/**
 * Permissions are just visibility values that the user can access.
 * E.g., ['researcher', 'math', 'cs'] means user can see agents with those visibility levels.
 * 'public' agents are always visible to authenticated users.
 *
 * Note: 'tier' column is reserved for future server-side API key access.
 */

/**
 * User's authorization context.
 * Permissions are visibility values stored in profiles.permissions column.
 */
export interface UserAuthContext {
  /** Visibility values user can access: ['researcher', 'math', etc.] */
  permissions: string[];
  /** User's tier (reserved for future API key access) */
  tier: string;
}

/**
 * Tier values for future server-side API key access.
 */
export type UserTier = 'free' | 'Max' | 'Ultra';

/**
 * Check if user has access to an agent's visibility levels.
 * Returns true if:
 * - Agent visibility includes 'public', OR
 * - There's any overlap between agent visibility and user permissions
 */
export function hasVisibilityAccess(
  permissions: string[],
  visibility: string | string[],
): boolean {
  const visibilityArray = Array.isArray(visibility) ? visibility : [visibility];
  // Public agents are always accessible
  if (visibilityArray.includes('public')) {
    return true;
  }
  // Check for any overlap between visibility and permissions
  return visibilityArray.some((v) => permissions.includes(v));
}

/**
 * Display labels and icons for OAuth providers.
 * Used in the sign-in QuickPick menu.
 */
export const OAUTH_PROVIDER_LABELS: Record<
  OAuthProvider,
  { label: string; icon: string }
> = {
  github: { label: 'GitHub', icon: '$(github)' },
  google: { label: 'Google', icon: '$(globe)' },
};

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
export const EXTENSION_ID = 'texra-ai.texra';

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
 * Used by both OAuth and magic link flows.
 */
export function getAuthCallbackUri(uriScheme: string): string {
  return `${uriScheme}://${getExtensionId()}/auth-callback`;
}

/** Timeout for waiting for OAuth callback (2 minutes in ms) */
export const AUTH_CALLBACK_TIMEOUT_MS = 2 * 60 * 1000;
