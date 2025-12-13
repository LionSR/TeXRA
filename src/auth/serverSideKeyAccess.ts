/**
 * Helper for determining server-side API key access.
 *
 * Server-side keys allow Ultra tier users to access AI models without
 * providing their own API keys. The keys are stored as Supabase Edge
 * Function secrets and accessed via the relay function.
 */

import { getConfig } from '@utils/config';
import { SupabaseClient } from './SupabaseClient';
import { SUPABASE_CUSTOM_DOMAIN } from './config';

/**
 * Supported providers for server-side API keys.
 * These match the providers configured in the relay Edge Function.
 */
export const SERVER_SIDE_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'moonshot',
  'dashscope',
] as const;

export type ServerSideProvider = (typeof SERVER_SIDE_PROVIDERS)[number];

/**
 * Cache for server-side key access check to avoid repeated database calls.
 * Cached for 5 minutes.
 */
let accessCache: { result: boolean; timestamp: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if the experimental setting for server-side keys is enabled.
 */
export function isServerSideKeysSettingEnabled(): boolean {
  return getConfig<boolean>('texra.experimental.useServerSideKeys', false);
}

/**
 * Clear the access cache. Call this when user signs in/out.
 */
export function clearServerSideKeyAccessCache(): void {
  accessCache = null;
}

/**
 * Check if the current user can use server-side API keys.
 *
 * Requirements:
 * 1. The experimental setting must be enabled
 * 2. User must be authenticated
 * 3. User must have Ultra tier
 *
 * Results are cached for 5 minutes to avoid repeated database calls.
 */
export async function canUseServerSideKeys(): Promise<boolean> {
  // Check setting first (fast, no network)
  if (!isServerSideKeysSettingEnabled()) {
    return false;
  }

  // Check cache
  if (accessCache && Date.now() - accessCache.timestamp < CACHE_TTL_MS) {
    return accessCache.result;
  }

  // Check authentication and tier
  const isAuthenticated = await SupabaseClient.isAuthenticated();
  if (!isAuthenticated) {
    accessCache = { result: false, timestamp: Date.now() };
    return false;
  }

  const tier = await SupabaseClient.getUserTier();
  const hasAccess = tier === 'Ultra';

  // Cache the result
  accessCache = { result: hasAccess, timestamp: Date.now() };

  return hasAccess;
}

/**
 * Check if a provider is supported for server-side keys.
 */
export function isProviderSupportedForServerSideKeys(
  provider: string,
): provider is ServerSideProvider {
  return SERVER_SIDE_PROVIDERS.includes(
    provider.toLowerCase() as ServerSideProvider,
  );
}

/**
 * Get the relay Edge Function base URL for a specific provider.
 * The URL structure is: /relay/{provider}/{...apiPath}
 * So for OpenAI, set baseURL to: https://remote.texra.ai/functions/v1/relay/openai
 *
 * @param provider - The provider name (e.g., 'openai', 'anthropic')
 * @returns The relay base URL for the provider
 */
export function getRelayBaseUrl(provider: string): string {
  return `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/relay/${provider.toLowerCase()}`;
}
