/**
 * Supabase configuration for TeXRA authentication and remote agents.
 *
 * These credentials are for TeXRA's official Supabase backend.
 * Users authenticate to TeXRA's service, not their own Supabase instance.
 *
 * Similar to how GitHub Copilot works - users sign in to the official service.
 */
import { SUPABASE_CONFIG, type OAuthProvider } from './sharedConfig';
export {
  AUTH_BRIDGE_URL,
  FREE_TIER,
  GITHUB_TOKEN_EXCHANGE_URL,
  GITHUB_TOKEN_REFRESH_URL,
  MAX_TIER,
  SUPABASE_CONFIG,
  SUPABASE_CUSTOM_DOMAIN,
  ULTRA_TIER,
  isOAuthProvider,
  type OAuthProvider,
  type UserTier,
} from './sharedConfig';

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
 * Used by both OAuth and magic link flows.
 *
 * Note: This returns the base URI. Use getExternalAuthCallbackUri() for
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
export { DEFAULT_SUPABASE_SESSION_EXPIRY_MS as DEFAULT_SESSION_EXPIRY_MS } from './supabaseSessionTypes';

/** Storage key for Supabase session in VS Code SecretStorage. */
export const SUPABASE_SESSION_KEY = 'texra.supabase.session';
