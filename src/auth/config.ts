/**
 * Supabase configuration for TeXRA authentication and remote agents.
 *
 * These credentials are for TeXRA's official Supabase backend.
 * Users authenticate to TeXRA's service, not their own Supabase instance.
 *
 * Similar to how GitHub Copilot works - users sign in to the official service.
 */
import { z } from 'zod';
import {
  SUPABASE_CONFIG,
  UserTierSchema,
  type OAuthProvider,
} from './sharedConfig';
export {
  FREE_TIER,
  GITHUB_TOKEN_EXCHANGE_URL,
  GITHUB_TOKEN_REFRESH_URL,
  MAX_TIER,
  OAUTH_PROVIDERS,
  SERVER_SIDE_CACHE_TTL_MS,
  SUPABASE_CONFIG,
  SUPABASE_CUSTOM_DOMAIN,
  ULTRA_TIER,
  UserTierSchema,
  isOAuthProvider,
  type OAuthProvider,
  type SupabaseConfig,
  type UserTier,
} from './sharedConfig';

/**
 * Official TeXRA Supabase configuration.
 *
 * These are the production credentials for TeXRA's official Supabase backend.
 * The public key (anon or publishable) is safe to include in client code.
 * Row Level Security (RLS) policies protect data access, not the key.
 */

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
export const UserAuthContextSchema = z.object({
  /** Visibility values user can access: ['researcher', 'math', etc.] */
  permissions: z.array(z.string()).catch([]),
  /** User's tier (reserved for future API key access) */
  tier: UserTierSchema.catch('free'),
});
export type UserAuthContext = z.infer<typeof UserAuthContextSchema>;

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
 *
 * Note: This returns the base URI. Use getExternalAuthCallbackUri() for
 * the environment-appropriate callback URL (handles Codespaces, Remote SSH, etc.)
 */
export function getAuthCallbackUri(uriScheme: string): string {
  return `${uriScheme}://${getExtensionId()}/auth-callback`;
}

/**
 * Result of parsing the external auth callback URI.
 * In Codespaces, VS Code adds a state parameter that must be preserved
 * for the callback routing to work.
 */
export interface ExternalAuthCallbackInfo {
  /** Base URL without query params (for Supabase redirectTo) */
  baseUrl: string;
  /** VS Code's state parameter (must be passed through OAuth flow) */
  vscodeState: string | null;
  /** Full URL with state (for logging/debugging) */
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
    const baseUrl = getAuthCallbackUri('vscode');
    return { baseUrl, vscodeState: null, fullUrl: baseUrl };
  }
  return externalAuthCallbackResolver();
}

/**
 * Get the environment-appropriate OAuth callback URI as a simple string.
 * Use getExternalAuthCallbackInfo() when you need access to parsed components.
 */
export async function getExternalAuthCallbackUri(): Promise<string> {
  const info = await getExternalAuthCallbackInfo();
  return info.fullUrl;
}

/** Timeout for waiting for OAuth callback (2 minutes in ms) */
export const AUTH_CALLBACK_TIMEOUT_MS = 2 * 60 * 1000;

/** Refresh token proactively if it expires within this threshold (30 minutes). */
export const TOKEN_REFRESH_THRESHOLD_MS = 30 * 60 * 1000;

/** Default session expiry time (1 hour). */
export { DEFAULT_SUPABASE_SESSION_EXPIRY_MS as DEFAULT_SESSION_EXPIRY_MS } from './SupabaseSession';

/** Storage key for Supabase session in VS Code SecretStorage. */
export const SUPABASE_SESSION_KEY = 'texra.supabase.session';
