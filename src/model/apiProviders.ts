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

/** Where a resolved API key came from. */
export type ApiKeyOrigin = 'secret' | 'env' | 'none';

interface ResolvedApiKey {
  value: string | undefined;
  origin: ApiKeyOrigin;
}

// Short-lived cache to dedupe concurrent secret scans across paths
// (e.g. computeModelOptions + settings-view profile refresh after a key
// change). Invalidate explicitly when a key is set or removed.
const LOOKUP_CACHE_TTL_MS = 5_000;
const lookupCache = new Map<
  ApiProvider,
  { value: ResolvedApiKey; expiry: number }
>();
const lookupPending = new Map<ApiProvider, Promise<ResolvedApiKey>>();

export function invalidateApiKeyCache(): void {
  lookupCache.clear();
  lookupPending.clear();
}

async function resolveApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<ResolvedApiKey> {
  const cached = lookupCache.get(provider);
  if (cached && Date.now() < cached.expiry) return cached.value;

  const inFlight = lookupPending.get(provider);
  if (inFlight) return inFlight;

  const request = (async (): Promise<ResolvedApiKey> => {
    const stored = await secrets.get(apiKeySecretName(provider));
    if (stored) return { value: stored, origin: 'secret' };
    const envValue = process.env[apiKeyEnvName(provider)];
    if (envValue) return { value: envValue, origin: 'env' };
    return { value: undefined, origin: 'none' };
  })();
  lookupPending.set(provider, request);
  try {
    const value = await request;
    lookupCache.set(provider, {
      value,
      expiry: Date.now() + LOOKUP_CACHE_TTL_MS,
    });
    return value;
  } finally {
    if (lookupPending.get(provider) === request) lookupPending.delete(provider);
  }
}

/**
 * Look up an API key from secrets storage, falling back to env var.
 * Returns undefined if no key is found.
 */
export async function lookupApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<string | undefined> {
  return (await resolveApiKey(secrets, provider)).value;
}

/**
 * Resolve where an API key for the given provider was loaded from
 * (`secret` storage, `env` var, or `none`). Shares the same TTL cache
 * as {@link lookupApiKey}.
 */
export async function lookupApiKeyOrigin(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<ApiKeyOrigin> {
  return (await resolveApiKey(secrets, provider)).origin;
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
