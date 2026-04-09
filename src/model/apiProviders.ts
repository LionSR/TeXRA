/**
 * API provider constants and key resolution utilities.
 *
 * Shared between SecretManager (VS Code), ModelHandler (agent core),
 * and computeModelOptions (model). Platform-agnostic.
 */
import type { PlatformSecrets } from '@platform/secrets';

export const API_PROVIDERS = [
  'openai',
  'anthropic',
  'openRouter',
  'google',
  'xai',
  'deepseek',
  'moonshot',
  'dashscope',
  'minimax',
  'glm',
] as const;

export type ApiProvider = (typeof API_PROVIDERS)[number];

/** Secret storage key for a provider's API key. */
export function apiKeySecretName(provider: ApiProvider): string {
  return `apiKey.${provider}`;
}

/** Environment variable name for a provider's API key. */
export function apiKeyEnvName(provider: ApiProvider): string {
  return `${provider.toUpperCase()}_API_KEY`;
}

/**
 * Look up an API key from secrets storage, falling back to env var.
 * Returns undefined if no key is found.
 */
export async function lookupApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<string | undefined> {
  const stored = await secrets.get(apiKeySecretName(provider));
  return stored ?? process.env[apiKeyEnvName(provider)];
}

/**
 * Get an API key, throwing if not found.
 */
export async function getApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<string> {
  const key = await lookupApiKey(secrets, provider);
  if (!key) {
    throw new Error(
      `No API key found for ${provider}. Please set it using the "Set API Key" command or ${apiKeyEnvName(provider)} environment variable.`,
    );
  }
  return key;
}

/**
 * Check if an API key exists for a provider.
 */
export async function apiKeyExists(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<boolean> {
  return (await lookupApiKey(secrets, provider)) !== undefined;
}
