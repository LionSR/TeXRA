/**
 * Helper for determining server-side API key access.
 *
 * Server-side keys allow Ultra tier users to access AI models without
 * providing their own API keys. The keys are stored as Supabase Edge
 * Function secrets and accessed via the relay function.
 *
 * PER-PROVIDER ENABLEMENT:
 * -----------------------
 * The relay server controls which providers are enabled. The client fetches
 * the list of enabled providers from `/relay/providers` and caches it.
 * This allows the server to enable/disable providers without client updates.
 *
 * INITIALIZATION REQUIREMENTS:
 * ----------------------------
 * The `canUseServerSideKeys()` async function MUST be called at least once
 * before `shouldUseServerSideKeysSync()` will return true. This is because:
 *
 * 1. `canUseServerSideKeys()` performs the async authentication and tier check
 * 2. It also fetches the list of enabled providers from the server
 * 3. Results are cached in `lastKnownAccessResult` and `enabledProvidersCache`
 * 4. `shouldUseServerSideKeysSync()` uses these cached values for sync decisions
 *
 * Call Sequence:
 * - `canUseServerSideKeys()` is called in `computeModelOptions()` when rendering
 *   the model dropdown, which primes the cache
 * - `shouldUseServerSideKeysSync()` is then safe to call from sync functions
 *   like `resolveBaseUrl()` and `getApiKey()`
 *
 * If `canUseServerSideKeys()` hasn't been called, `shouldUseServerSideKeysSync()`
 * will return false, causing fallback to normal API key behavior.
 *
 * API KEY DETECTION:
 * -----------------
 * Use `getEnabledProvidersSync()` to get the list of providers that have
 * server-side keys available. This can be used to skip "missing API key"
 * warnings for providers that are available via relay.
 */

import * as vscode from 'vscode';
import { SupabaseClient } from './SupabaseClient';
import { SUPABASE_CUSTOM_DOMAIN } from './config';

/**
 * Global state key for the "use included model access" preference.
 * This is an internal setting (not exposed in VS Code settings) that
 * Ultra tier users control via the profile view.
 */
const USE_INCLUDED_ACCESS_KEY = 'texra.useIncludedModelAccess';

/**
 * In-memory state for the setting. Defaults to true (use included access).
 * This is loaded from globalState on initialization and can be updated
 * via setUseIncludedModelAccess().
 */
let useIncludedModelAccess: boolean = true;

/**
 * Reference to the extension context's globalState for persistence.
 * Set via initializeServerSideKeyAccess().
 */
let globalState: vscode.Memento | null = null;

/**
 * Event emitter for model access setting changes.
 * Fire this when the setting changes so listeners can refresh.
 */
const _onDidChangeModelAccess = new vscode.EventEmitter<boolean>();

/**
 * Event that fires when the "use included model access" setting changes.
 * Subscribe to this to refresh model options when the setting is toggled.
 */
export const onDidChangeModelAccess = _onDidChangeModelAccess.event;

/**
 * All providers that could potentially support server-side API keys.
 * The actual enabled providers are fetched from the relay server at runtime.
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
 * Cache for enabled providers fetched from the relay server.
 * This is populated by fetchEnabledProviders() and used for sync checks.
 */
let enabledProvidersCache: string[] = [];
let enabledProvidersCacheTimestamp: number = 0;
let enabledProvidersCachePromise: Promise<string[]> | null = null;
const PROVIDERS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Cache for server-side key access check.
 * Uses Promise-based caching to avoid race conditions.
 */
let accessCachePromise: Promise<boolean> | null = null;
let accessCacheTimestamp: number = 0;
let lastKnownAccessResult: boolean = false;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Initialize the server-side key access module with the extension context.
 * Call this once during extension activation to enable state persistence.
 *
 * @param context - The VS Code extension context
 */
export function initializeServerSideKeyAccess(
  context: vscode.ExtensionContext,
): void {
  // Register EventEmitter for disposal when extension deactivates
  context.subscriptions.push(_onDidChangeModelAccess);

  globalState = context.globalState;
  // Load persisted value, defaulting to true (use included access)
  useIncludedModelAccess = globalState.get<boolean>(
    USE_INCLUDED_ACCESS_KEY,
    true,
  );
}

/**
 * Check if the "use included model access" setting is enabled.
 * This is the internal check for whether server-side keys should be used.
 */
export function isServerSideKeysSettingEnabled(): boolean {
  return useIncludedModelAccess;
}

/**
 * Set the "use included model access" preference.
 * This persists the setting to globalState and updates the in-memory value.
 * Also clears the access cache, pre-fetches enabled providers (if enabling),
 * and fires the onDidChangeModelAccess event so listeners can refresh.
 *
 * @param value - True to use included access, false to use personal keys
 */
export async function setUseIncludedModelAccess(value: boolean): Promise<void> {
  const changed = useIncludedModelAccess !== value;
  useIncludedModelAccess = value;
  if (globalState) {
    await globalState.update(USE_INCLUDED_ACCESS_KEY, value);
  }
  if (changed) {
    // Clear cache BEFORE fetching fresh data
    clearServerSideKeyAccessCache();

    // If enabling, pre-fetch providers so cache is warm when listeners refresh
    // This ensures model options are computed with the latest provider list
    if (value) {
      await getEnabledProviders();
    }

    _onDidChangeModelAccess.fire(value);
  }
}

/**
 * Get the current "use included model access" preference.
 */
export function getUseIncludedModelAccess(): boolean {
  return useIncludedModelAccess;
}

/**
 * Clear the access cache. Call this when user signs in/out.
 */
export function clearServerSideKeyAccessCache(): void {
  accessCachePromise = null;
  accessCacheTimestamp = 0;
  lastKnownAccessResult = false;
  enabledProvidersCache = [];
  enabledProvidersCacheTimestamp = 0;
  enabledProvidersCachePromise = null;
}

/**
 * Internal function to fetch access status.
 */
async function fetchAccessStatus(): Promise<boolean> {
  try {
    const isAuthenticated = await SupabaseClient.isAuthenticated();
    if (!isAuthenticated) {
      lastKnownAccessResult = false;
      return false;
    }

    const tier = await SupabaseClient.getUserTier();
    // Explicitly check for 'Ultra' - undefined/null/errors all result in false
    const hasAccess = tier === 'Ultra';
    lastKnownAccessResult = hasAccess;
    return hasAccess;
  } catch {
    // On any error (network, auth, etc.), deny access and allow retry
    lastKnownAccessResult = false;
    return false;
  }
}

/**
 * Fetch list of enabled providers from the relay server.
 * This is a public endpoint that returns providers with configured API keys.
 */
async function fetchEnabledProvidersFromServer(): Promise<string[]> {
  try {
    const url = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/relay/providers`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      console.error(
        `[ServerSideKeys] Failed to fetch providers: ${response.status}`,
      );
      return [];
    }

    const data = await response.json();
    if (Array.isArray(data.providers)) {
      enabledProvidersCache = data.providers;
      return data.providers;
    }

    return [];
  } catch (error) {
    console.error('[ServerSideKeys] Error fetching providers:', error);
    return [];
  }
}

/**
 * Get the list of enabled providers from the relay server.
 * Results are cached for 5 minutes.
 */
export async function getEnabledProviders(): Promise<string[]> {
  const now = Date.now();

  // Check if cache is still valid
  if (
    enabledProvidersCachePromise &&
    now - enabledProvidersCacheTimestamp < PROVIDERS_CACHE_TTL_MS
  ) {
    return enabledProvidersCachePromise;
  }

  // Create new cache entry
  enabledProvidersCacheTimestamp = now;
  enabledProvidersCachePromise = fetchEnabledProvidersFromServer();

  return enabledProvidersCachePromise;
}

/**
 * Get the cached list of enabled providers (synchronous).
 * Returns empty array if providers haven't been fetched yet.
 */
export function getEnabledProvidersSync(): string[] {
  return enabledProvidersCache;
}

/**
 * Check if the current user can use server-side API keys.
 *
 * Requirements:
 * 1. The experimental setting must be enabled
 * 2. User must be authenticated
 * 3. User must have Ultra tier
 * 4. At least one provider must be enabled on the server
 *
 * Results are cached for 5 minutes to avoid repeated database calls.
 * Uses Promise-based caching to prevent race conditions.
 *
 * This function also fetches the list of enabled providers from the server,
 * priming the cache for shouldUseServerSideKeysSync().
 */
export async function canUseServerSideKeys(): Promise<boolean> {
  // Check setting first (fast, no network)
  if (!isServerSideKeysSettingEnabled()) {
    // Clear entire cache when setting is disabled to ensure fresh check when re-enabled
    // This prevents stale cached promise from being used if setting is toggled back on
    clearServerSideKeyAccessCache();
    return false;
  }

  const now = Date.now();

  // Check if cache is still valid
  if (accessCachePromise && now - accessCacheTimestamp < CACHE_TTL_MS) {
    return accessCachePromise;
  }

  // Create new cache entry (Promise-based to prevent race conditions)
  // Note: fetchAccessStatus() handles errors internally and returns false,
  // so transient failures are cached for the TTL. This is intentional to
  // avoid hammering the auth service on repeated failures.
  accessCacheTimestamp = now;
  accessCachePromise = (async () => {
    // Fetch both access status and enabled providers in parallel
    const [hasAccess, providers] = await Promise.all([
      fetchAccessStatus(),
      getEnabledProviders(),
    ]);

    // Must have access AND at least one enabled provider
    return hasAccess && providers.length > 0;
  })();

  return accessCachePromise;
}

/**
 * Synchronous check if server-side keys should be used for routing.
 *
 * IMPORTANT: This only returns true if:
 * 1. The setting is enabled
 * 2. The provider is enabled on the server (has API key configured)
 * 3. A previous async check (canUseServerSideKeys) confirmed access
 *
 * PREREQUISITE: canUseServerSideKeys() must have been called and completed
 * before this function will return true. This typically happens when:
 * - computeModelOptions() renders the model dropdown
 * - Any other code path that calls canUseServerSideKeys() first
 *
 * If canUseServerSideKeys() hasn't been called yet or returned false,
 * this will return false to ensure URL routing and API key retrieval
 * stay synchronized. This is intentional - it causes safe fallback to
 * normal API key behavior rather than sending requests to the relay
 * that would fail authentication.
 *
 * RACE CONDITION NOTE:
 * Both resolveBaseUrl() and getApiKey() call this function independently.
 * Theoretically, if lastKnownAccessResult changes between the two calls
 * (e.g., cache expires and another async operation triggers refresh),
 * the routing could be inconsistent. In practice this is extremely unlikely:
 * - Cache TTL is 5 minutes, requests typically take <30 seconds
 * - canUseServerSideKeys() is only called when rendering model dropdown
 * - The failure mode is API error (not security issue)
 * If this becomes a problem, consider computing the decision once per
 * request and passing it through both code paths.
 *
 * This synchronous function is needed because getBaseUrl() is synchronous.
 */
export function shouldUseServerSideKeysSync(provider: string): boolean {
  // Setting must be enabled
  if (!isServerSideKeysSettingEnabled()) {
    return false;
  }

  // Provider must be enabled on the server (has API key configured)
  const normalizedProvider = provider.toLowerCase();
  if (!enabledProvidersCache.includes(normalizedProvider)) {
    return false;
  }

  // Must have confirmed access from a prior async check
  // This ensures routing and API key decisions are synchronized
  return lastKnownAccessResult === true;
}

/**
 * Check if a provider is enabled for server-side keys on the server.
 *
 * This checks against the cached list of enabled providers fetched from
 * the relay server. Returns false if providers haven't been fetched yet.
 *
 * Note: This accepts both string literals and ModelProvider enum values.
 * The toLowerCase() call ensures case-insensitive matching.
 */
export function isProviderEnabledForServerSideKeys(provider: string): boolean {
  return enabledProvidersCache.includes(provider.toLowerCase());
}

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
