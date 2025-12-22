/**
 * URL routing for server-side API keys.
 *
 * Handles generating relay URLs for proxying API requests through
 * the Supabase Edge Function.
 */

import { SUPABASE_CUSTOM_DOMAIN } from '../config';
import type { ServerSideProvider } from './types';

/**
 * Path suffixes for relay URLs, matching SDK expectations.
 *
 * Different SDKs have different conventions for how they construct URLs:
 * - OpenAI SDK: uses /v1 in baseURL, appends /chat/completions
 * - Anthropic SDK: appends /v1/messages to baseURL
 * - Google SDK: uses different path structure
 *
 * These suffixes ensure the relay URL matches what each SDK expects.
 */
const RELAY_PATH_SUFFIXES: Partial<Record<ServerSideProvider, string>> = {
  openai: '/v1',
  xai: '/v1',
  moonshot: '/v1',
  dashscope: '/compatible-mode/v1',
  // anthropic, google, deepseek - SDKs add version path themselves
};

/**
 * Get the relay Edge Function base URL for a specific provider.
 * The URL structure is: /relay/{provider}[/pathSuffix]
 *
 * Example URLs:
 * - OpenAI: https://remote.texra.ai/functions/v1/relay/openai/v1
 * - Anthropic: https://remote.texra.ai/functions/v1/relay/anthropic
 *
 * @param provider - The provider name (e.g., 'openai', 'anthropic')
 * @returns The relay base URL for the provider
 */
export function getRelayBaseUrl(provider: string): string {
  const normalizedProvider = provider.toLowerCase() as ServerSideProvider;
  const suffix = RELAY_PATH_SUFFIXES[normalizedProvider] ?? '';
  return `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/relay/${normalizedProvider}${suffix}`;
}
