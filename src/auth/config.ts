/**
 * Supabase configuration for TeXRA authentication and remote agents.
 *
 * These credentials are for TeXRA's official Supabase backend.
 * Users authenticate to TeXRA's service, not their own Supabase instance.
 *
 * Similar to how GitHub Copilot works - users sign in to the official service.
 */
import * as vscode from 'vscode';
import { z } from 'zod';

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
 * Edge function URL for GitHub token exchange.
 * Used in VS Code web/Codespaces where standard OAuth callbacks don't work.
 */
export const GITHUB_TOKEN_EXCHANGE_URL = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/auth-github-token`;

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
 * Tier values for server-side API key access.
 */
export const UserTierSchema = z.enum(['free', 'Max', 'Ultra']);
export type UserTier = z.infer<typeof UserTierSchema>;

/**
 * Ultra tier constant for server-side API key access checks.
 *
 * CROSS-REFERENCE: Duplicated in supabase/functions/relay/index.ts
 * because Deno Edge Functions cannot import TypeScript source.
 * Update both locations when changing tier values.
 */
export const ULTRA_TIER: UserTier = 'Ultra';

/**
 * Max tier constant for server-side API key access (cheaper models).
 *
 * CROSS-REFERENCE: Duplicated in supabase/functions/relay/index.ts
 * because Deno Edge Functions cannot import TypeScript source.
 * Update both locations when changing tier values.
 */
export const MAX_TIER: UserTier = 'Max';

/**
 * Free tier constant for server-side API key access (budget models).
 *
 * CROSS-REFERENCE: Duplicated in supabase/functions/relay/index.ts
 * because Deno Edge Functions cannot import TypeScript source.
 * Update both locations when changing tier values.
 */
export const FREE_TIER: UserTier = 'free';

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
 * Check if user has access to an agent's visibility levels.
 * Returns true if:
 * - Agent visibility includes 'public', OR
 * - There's any overlap between agent visibility and user permissions
 *
 * Note: Server-side RLS handles primary access control. This function is for:
 * - Client-side pre-filtering (e.g., UI hints before server roundtrip)
 * - Testing and validation
 * - Future use cases where client-side access checks are needed
 */
export function hasVisibilityAccess(
  permissions: string[],
  visibility: string | string[] | undefined | null,
): boolean {
  // Handle undefined/null visibility - treat as public
  if (!visibility) {
    return true;
  }
  const visibilityArray = Array.isArray(visibility) ? visibility : [visibility];
  // Filter out any undefined/null elements
  const cleanedVisibility = visibilityArray.filter(
    (v): v is string => typeof v === 'string',
  );
  // Empty visibility array is treated as public
  if (cleanedVisibility.length === 0) {
    return true;
  }
  // Public agents are always accessible
  if (cleanedVisibility.includes('public')) {
    return true;
  }
  // Check for any overlap between visibility and permissions
  return cleanedVisibility.some((v) => permissions.includes(v));
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
 *
 * Note: This returns the base URI. Use getExternalAuthCallbackUri() for
 * the environment-appropriate callback URL (handles Codespaces, Remote SSH, etc.)
 */
export function getAuthCallbackUri(uriScheme: string): string {
  return `${uriScheme}://${getExtensionId()}/auth-callback`;
}

/**
 * Get the environment-appropriate OAuth callback URI.
 * Uses vscode.env.asExternalUri() to handle different environments:
 * - Desktop VS Code: returns vscode://texra-ai.texra/auth-callback
 * - Cursor: returns cursor://texra-ai.texra/auth-callback
 * - Codespaces: returns https://*.github.dev/extension-auth-callback
 * - Remote SSH: handles port forwarding automatically
 */
export async function getExternalAuthCallbackUri(): Promise<string> {
  const baseCallbackUri = vscode.Uri.parse(
    getAuthCallbackUri(vscode.env.uriScheme),
  );
  const externalUri = await vscode.env.asExternalUri(baseCallbackUri);
  return externalUri.toString();
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

/**
 * Get the external auth callback URI with parsed components.
 * In Codespaces, VS Code generates a state parameter that MUST be preserved
 * and passed through the OAuth flow for the callback routing to work.
 *
 * Without this, the callback URL gets the state URL-encoded into the path,
 * breaking VS Code's ability to route it to the extension.
 */
export async function getExternalAuthCallbackInfo(): Promise<ExternalAuthCallbackInfo> {
  const baseCallbackUri = vscode.Uri.parse(
    getAuthCallbackUri(vscode.env.uriScheme),
  );
  const externalUri = await vscode.env.asExternalUri(baseCallbackUri);

  // Parse VS Code's state parameter if present (added in Codespaces/web)
  const queryParams = new URLSearchParams(externalUri.query);
  const vscodeState = queryParams.get('state');

  // Build base URL without query params
  const baseUrl = `${externalUri.scheme}://${externalUri.authority}${externalUri.path}`;

  return {
    baseUrl,
    vscodeState,
    fullUrl: externalUri.toString(),
  };
}

/** Timeout for waiting for OAuth callback (2 minutes in ms) */
export const AUTH_CALLBACK_TIMEOUT_MS = 2 * 60 * 1000;

/** Cache TTL for server-side key access and tier config (5 minutes). */
export const SERVER_SIDE_CACHE_TTL_MS = 5 * 60 * 1000;

/** Refresh token proactively if it expires within this threshold (30 minutes). */
export const TOKEN_REFRESH_THRESHOLD_MS = 30 * 60 * 1000;

/** Default session expiry time (1 hour). */
export const DEFAULT_SESSION_EXPIRY_MS = 60 * 60 * 1000;

/** Storage key for Supabase session in VS Code SecretStorage. */
export const SUPABASE_SESSION_KEY = 'texra.supabase.session';
