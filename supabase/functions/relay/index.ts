/**
 * Relay Edge Function - Server-side API key proxy for authenticated users.
 *
 * ============================================================================
 * RESEARCHER ACCESS PROGRAM
 * ============================================================================
 * This relay provides server-side API keys as a convenience for researchers
 * and academics. Users can ALWAYS choose between:
 * - Server-side keys (no API key needed, subject to fair use)
 * - Their own API keys (full control, no restrictions)
 *
 * FAIR USE POLICY:
 * - Personal research and academic use only
 * - No commercial use or production deployments
 * - No automated/bot access or bulk operations
 * - Excessive usage may result in account suspension
 *
 * Users can toggle between server and personal API keys in their profile.
 * ============================================================================
 *
 * TIER HIERARCHY (cumulative access):
 * - Ultra: All models including premium ($3+/M input)
 * - Max: Mid-tier models ($1-3/M) + all free tier models
 * - free: Budget models only (under $1/M input)
 *
 * Authentication: JWT tokens are extracted from SDK auth headers:
 * - OpenAI: Authorization: Bearer {jwt}
 * - Anthropic: x-api-key: {jwt}
 * - Google: x-goog-api-key: {jwt}
 *
 * The relay validates the JWT, checks user tier, then replaces it with the
 * real API key before forwarding to the upstream provider.
 *
 * Endpoints:
 * - GET /relay/providers - Returns list of providers with configured API keys (public)
 * - GET /relay/tier-config - Returns tier-based model access configuration (public)
 * - POST /relay/{provider}/{...path} - Proxy request to provider (requires Ultra/Max tier)
 *
 * Example: /relay/openai/v1/chat/completions
 *
 * Supported providers: openai, anthropic, google, xai, deepseek, moonshot, dashscope
 *
 * IMPORTANT: Deploy with --no-verify-jwt flag since we validate JWTs manually
 * (SDKs send JWT in provider-specific headers, not the standard Authorization header).
 */

// Relay version for debugging deployments
const RELAY_VERSION = '1.4.0';

/**
 * Tier values - MUST match constants in src/auth/config.ts
 *
 * CROSS-REFERENCE: These are duplicated because the relay runs in Deno
 * and cannot import from the TypeScript source. Keep in sync with:
 * - src/auth/config.ts: ULTRA_TIER, MAX_TIER, FREE_TIER constants
 * - Database: profiles.tier column values
 *
 * If adding/changing tiers, update ALL locations.
 *
 * TIER HIERARCHY (ascending access):
 * - free: Budget models only (under $1/M input)
 * - Max: Free tier models + mid-tier models ($1-3/M input)
 * - Ultra: All models including premium ($3+/M input)
 */
const ULTRA_TIER = 'Ultra';
const MAX_TIER = 'Max';
const FREE_TIER = 'free';

// ============================================================================
// Tier-Based Model Access Configuration
// ============================================================================

/**
 * Configuration for which models and providers are available for each tier.
 * This is the SERVER-SIDE source of truth for tier access.
 *
 * IMPORTANT: Keep this synchronized with docs/relay-tier-config.md
 *
 * Model naming follows src/model/ModelRegistry.ts short names.
 */
interface TierAccessConfig {
  /** Model access: "*" for all models, or array of specific model short names */
  models: '*' | string[];
  /** Providers enabled for this tier */
  providers: string[];
}

interface TierModelConfig {
  tiers: {
    free?: TierAccessConfig;
    Max?: TierAccessConfig;
    Ultra?: TierAccessConfig;
  };
}

// ============================================================================
// SINGLE SOURCE OF TRUTH: Relay Model Configuration
// ============================================================================
/**
 * Each model entry specifies:
 * - shortName: TeXRA UI identifier (returned to client via /relay/tier-config)
 * - apiPatterns: Array of full API model name prefixes for server-side validation
 *                (supports multiple patterns for aliases like gemini-flash-latest)
 * - minTier: Minimum tier required to access this model
 *
 * TIER ACCESS IS CUMULATIVE:
 * - free tier: Models where minTier = 'free'
 * - Max tier: Models where minTier = 'free' OR 'Max'
 * - Ultra tier: All models (including minTier = 'Ultra')
 *
 * IMPORTANT: When adding/removing models, update ONLY this array.
 * All derived arrays and TIER_CONFIG are auto-generated from this.
 *
 * Keep synchronized with:
 * - src/model/providers/*.ts (fullName field must match apiPattern prefix)
 * - docs/relay-tier-config.md
 */
type MinTier = 'free' | 'Max' | 'Ultra';

interface RelayModel {
  shortName: string; // UI identifier (e.g., "gpt41-")
  apiPatterns: string[]; // API name prefixes for validation
  minTier: MinTier; // Minimum tier required
}

const RELAY_MODELS: RelayModel[] = [
  // =========================================================================
  // FREE TIER: Budget models (under $1/M input)
  // Available to all authenticated users without subscription.
  // =========================================================================

  // Anthropic - Haiku models (very cheap)
  { shortName: 'haiku3', apiPatterns: ['claude-3-haiku'], minTier: 'free' }, // $0.25/$1.25
  { shortName: 'haiku35', apiPatterns: ['claude-3-5-haiku'], minTier: 'free' }, // $0.80/$4.00

  // OpenAI - Mini/Nano models (very cheap)
  { shortName: 'gpt5-', apiPatterns: ['gpt-5-mini'], minTier: 'free' }, // $0.25/$2.00
  { shortName: 'gpt5--', apiPatterns: ['gpt-5-nano'], minTier: 'free' }, // $0.05/$0.40
  { shortName: 'gpt41-', apiPatterns: ['gpt-4.1-mini'], minTier: 'free' }, // $0.40/$1.60
  { shortName: 'gpt41--', apiPatterns: ['gpt-4.1-nano'], minTier: 'free' }, // $0.10/$0.40
  { shortName: 'gpt4o-', apiPatterns: ['gpt-4o-mini'], minTier: 'free' }, // $0.15/$0.60

  // Google - Flash models (very cheap)
  { shortName: 'gemini3f', apiPatterns: ['gemini-3-flash'], minTier: 'free' }, // $0.30/$2.50
  // gemini25f maps to multiple API names (versioned + latest alias)
  {
    shortName: 'gemini25f',
    apiPatterns: ['gemini-2.5-flash', 'gemini-flash'],
    minTier: 'free',
  }, // $0.30/$2.50
  {
    shortName: 'gemini25f-',
    apiPatterns: ['gemini-2.5-flash-lite'],
    minTier: 'free',
  }, // $0.10/$0.40

  // DeepSeek - Chat and Reasoner (very cheap)
  { shortName: 'deepseek', apiPatterns: ['deepseek-chat'], minTier: 'free' }, // $0.28/$0.42
  {
    shortName: 'deepseekT',
    apiPatterns: ['deepseek-reasoner'],
    minTier: 'free',
  }, // $0.28/$0.42

  // xAI - Grok Mini (very cheap)
  { shortName: 'grok3-', apiPatterns: ['grok-3-mini'], minTier: 'free' }, // $0.30/$0.50

  // Moonshot - Kimi models (very cheap)
  { shortName: 'kimi128k', apiPatterns: ['moonshot-v1-128k'], minTier: 'free' }, // $0.28/$1.12
  {
    shortName: 'kimi128kv',
    apiPatterns: ['moonshot-v1-128k-vision'],
    minTier: 'free',
  }, // $0.35/$1.40
  {
    shortName: 'kimit',
    apiPatterns: ['kimi-thinking-preview'],
    minTier: 'free',
  }, // $0.42/$1.68
  { shortName: 'kimi2', apiPatterns: ['kimi-k2-0905'], minTier: 'free' }, // $0.60/$2.50
  { shortName: 'kimi2T', apiPatterns: ['kimi-k2-thinking'], minTier: 'free' }, // $0.56/$2.22

  // =========================================================================
  // MAX TIER: Mid-tier models ($1-3/M input)
  // Requires Max subscription, includes all free tier models
  // =========================================================================

  // Anthropic - Haiku 4.5 and Sonnet 4.5
  { shortName: 'haiku45', apiPatterns: ['claude-haiku-4-5'], minTier: 'Max' }, // $1.00/$5.00
  { shortName: 'haiku45T', apiPatterns: ['claude-haiku-4-5'], minTier: 'Max' }, // $1.00/$5.00
  {
    shortName: 'sonnet45T',
    apiPatterns: ['claude-sonnet-4-5'],
    minTier: 'Max',
  }, // $3.00/$15.00

  // Google - Gemini Pro models
  { shortName: 'gemini3p', apiPatterns: ['gemini-3-pro'], minTier: 'Max' }, // $2.00/$12.00
  { shortName: 'gemini25p', apiPatterns: ['gemini-2.5-pro'], minTier: 'Max' }, // $1.25/$10.00

  // xAI - Grok 2 models
  { shortName: 'grok2', apiPatterns: ['grok-2-1212'], minTier: 'Max' }, // $2.00/$10.00
  { shortName: 'grok2v', apiPatterns: ['grok-2-1212-vision'], minTier: 'Max' }, // $2.00/$10.00

  // Moonshot - Kimi Turbo models (faster but pricier)
  { shortName: 'kimi2+', apiPatterns: ['kimi-k2-turbo'], minTier: 'Max' }, // $2.24/$8.88
  {
    shortName: 'kimi2T+',
    apiPatterns: ['kimi-k2-thinking-turbo'],
    minTier: 'Max',
  }, // $2.24/$8.88

  // =========================================================================
  // ULTRA TIER: Premium models ($3+/M input)
  // Requires Ultra subscription (models: '*' grants all access)
  // Examples: Opus, GPT-5 series, DeepSeek R1, Grok 3/4
  // These are NOT listed here since Ultra uses models: '*'
  // =========================================================================
];

// ============================================================================
// Derived Arrays (auto-generated from RELAY_MODELS)
// ============================================================================

/** Get models available for a specific tier (cumulative access) */
function getModelsForTier(tier: MinTier): RelayModel[] {
  if (tier === 'Ultra') return RELAY_MODELS; // Ultra gets everything
  if (tier === 'Max')
    return RELAY_MODELS.filter(
      (m) => m.minTier === 'free' || m.minTier === 'Max',
    );
  return RELAY_MODELS.filter((m) => m.minTier === 'free');
}

// Pre-computed arrays for each tier
const FREE_TIER_MODELS = getModelsForTier('free');
const MAX_TIER_MODELS = getModelsForTier('Max');

const FREE_TIER_SHORT_NAMES = FREE_TIER_MODELS.map((m) => m.shortName);
const MAX_TIER_SHORT_NAMES = MAX_TIER_MODELS.map((m) => m.shortName);

const FREE_TIER_API_PATTERNS = FREE_TIER_MODELS.flatMap((m) =>
  m.apiPatterns.map((p) => p.toLowerCase()),
);
const MAX_TIER_API_PATTERNS = MAX_TIER_MODELS.flatMap((m) =>
  m.apiPatterns.map((p) => p.toLowerCase()),
);

// Provider access by tier
// Base providers available to all tiers - model access is what differentiates tiers
const BASE_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'xai',
  'moonshot',
] as const;

// Ultra tier gets additional providers (DashScope for Qwen models)
const ULTRA_ONLY_PROVIDERS = ['dashscope'] as const;
const ULTRA_TIER_PROVIDERS = [...BASE_PROVIDERS, ...ULTRA_ONLY_PROVIDERS];

const TIER_CONFIG: TierModelConfig = {
  tiers: {
    free: {
      // Free tier: Budget models only (under $1/M input)
      models: FREE_TIER_SHORT_NAMES,
      providers: [...BASE_PROVIDERS],
    },
    Max: {
      // Max tier: Free + mid-tier models ($1-3/M input)
      // GUARDS (Ultra-only): Opus, GPT-5 series, DeepSeek R1
      models: MAX_TIER_SHORT_NAMES,
      providers: [...BASE_PROVIDERS],
    },
    Ultra: {
      // Ultra tier: All models including premium ($3+/M)
      models: '*',
      providers: ULTRA_TIER_PROVIDERS,
    },
  },
};

/**
 * Check if a model is allowed for a given tier.
 * Uses prefix pattern matching against tier-specific API patterns
 * to handle version suffixes in model names.
 *
 * TIER ACCESS IS CUMULATIVE:
 * - Ultra: All models
 * - Max: MAX_TIER_API_PATTERNS (includes free tier models)
 * - free: FREE_TIER_API_PATTERNS (budget models only)
 */
function isModelAllowedForTier(
  tier: string,
  modelName: string | null,
): boolean {
  if (tier === ULTRA_TIER) {
    return true; // Ultra gets all models
  }

  // Model name is required for Max and free tier validation
  if (!modelName) return false;

  // Use pattern matching - model name must start with one of the allowed patterns
  // API patterns are already lowercased during derivation
  const normalizedModel = modelName.toLowerCase();

  if (tier === MAX_TIER) {
    return MAX_TIER_API_PATTERNS.some((pattern) =>
      normalizedModel.startsWith(pattern),
    );
  }

  if (tier === FREE_TIER) {
    return FREE_TIER_API_PATTERNS.some((pattern) =>
      normalizedModel.startsWith(pattern),
    );
  }

  return false; // Unknown tier gets no access
}

/**
 * Check if a provider is allowed for a given tier.
 */
function isProviderAllowedForTier(tier: string, provider: string): boolean {
  if (tier === ULTRA_TIER) {
    return ULTRA_TIER_PROVIDERS.includes(provider);
  }

  // Max and free tiers use the same base providers
  if (tier === MAX_TIER || tier === FREE_TIER) {
    return BASE_PROVIDERS.includes(provider as (typeof BASE_PROVIDERS)[number]);
  }

  return false;
}

/**
 * Extract model name from URL path for providers that embed it in the URL.
 *
 * Google GenAI SDK uses paths like:
 * - /models/gemini-2.5-flash:generateContent
 * - /models/gemini-2.5-pro:streamGenerateContent
 *
 * @param apiPath - The API path after the provider prefix
 * @returns The model name or null if not found
 */
function extractModelFromPath(apiPath: string): string | null {
  // Google GenAI pattern: /models/{model-name}:{method}
  const googleMatch = apiPath.match(/^models\/([^:]+)/);
  if (googleMatch) {
    return googleMatch[1];
  }

  return null;
}

import { createClient } from 'jsr:@supabase/supabase-js@2';

// Provider configurations
//
// IMPORTANT: This list MUST stay synchronized with:
// - SERVER_SIDE_PROVIDERS in src/auth/serverSideKeyAccess.ts
// - Provider documentation in docs/supabase/RELAY_SETUP.md
//
// Note: baseUrl should NOT include trailing paths like /v1 since the full path
// comes from the client request. The relay URL structure is:
// /relay/{provider}/{...apiPath}
// Example: /relay/openai/v1/chat/completions -> https://api.openai.com/v1/chat/completions

/** Supported provider keys for compile-time safety when adding providers. */
type ProviderKey =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'moonshot'
  | 'dashscope';

interface ProviderConfig {
  baseUrl: string;
  authType: 'bearer' | 'x-api-key' | 'x-goog-api-key';
  envKey: string;
}

const PROVIDER_CONFIGS: Record<ProviderKey, ProviderConfig> = {
  openai: {
    baseUrl: 'https://api.openai.com',
    authType: 'bearer',
    envKey: 'OPENAI_API_KEY',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    authType: 'x-api-key',
    envKey: 'ANTHROPIC_API_KEY',
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    authType: 'x-goog-api-key',
    envKey: 'GOOGLE_API_KEY',
  },
  xai: {
    // Note: xAI API expects /v1 in the path, which comes from the client
    baseUrl: 'https://api.x.ai',
    authType: 'bearer',
    envKey: 'XAI_API_KEY',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    authType: 'bearer',
    envKey: 'DEEPSEEK_API_KEY',
  },
  moonshot: {
    // Note: Moonshot API expects /v1 in the path, which comes from the client
    baseUrl: 'https://api.moonshot.cn',
    authType: 'bearer',
    envKey: 'MOONSHOT_API_KEY',
  },
  dashscope: {
    // Note: DashScope API expects /compatible-mode/v1 in the path, which comes from the client
    baseUrl: 'https://dashscope-intl.aliyuncs.com',
    authType: 'bearer',
    envKey: 'DASHSCOPE_API_KEY',
  },
};

/** Type guard to check if a string is a valid provider key. */
function isProviderKey(key: string): key is ProviderKey {
  return key in PROVIDER_CONFIGS;
}

/** Get provider config with type safety. Returns undefined for unknown providers. */
function getProviderConfig(provider: string): ProviderConfig | undefined {
  return isProviderKey(provider) ? PROVIDER_CONFIGS[provider] : undefined;
}

// CORS headers
// Note: VS Code extensions make requests from the extension host (Node.js process),
// not from a browser context, so Origin headers aren't typically present.
// The wildcard is used for:
// 1. Development/testing scenarios
// 2. Webview contexts (which have origins like vscode-webview://*)
// Security is enforced via JWT validation, not CORS origin checking.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  // Allow common SDK headers from all providers
  'Access-Control-Allow-Headers': [
    // Standard headers
    'authorization',
    'content-type',
    'accept',
    // TeXRA auth headers
    'x-texra-auth',
    'x-client-info',
    'apikey',
    // Anthropic SDK headers
    'x-api-key',
    'anthropic-version',
    'anthropic-beta',
    'x-stainless-lang',
    'x-stainless-package-version',
    'x-stainless-os',
    'x-stainless-arch',
    'x-stainless-runtime',
    'x-stainless-runtime-version',
    // Google SDK headers
    'x-goog-api-key',
    'x-goog-api-client',
    // OpenAI SDK headers
    'openai-beta',
    'openai-organization',
    'openai-project',
  ].join(', '),
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

/**
 * Extract JWT token from request headers.
 *
 * SDKs send their credentials in provider-specific headers. When the user's JWT
 * is passed as the "apiKey" to the SDK, it arrives here in these headers.
 *
 * Priority order:
 * 1. Custom header: x-texra-auth: {token} (explicit TeXRA auth)
 * 2. Authorization: Bearer {token} (OpenAI SDK)
 * 3. x-api-key: {token} (Anthropic SDK)
 * 4. x-goog-api-key: {token} (Google SDK)
 *
 * Note: Query parameters were intentionally removed for security (they appear
 * in server logs, browser history, and referrer headers).
 */
function extractJwtFromRequest(req: Request): string | null {
  // 1. Check custom TeXRA auth header (explicit auth for edge cases)
  const texraAuth = req.headers.get('x-texra-auth');
  if (texraAuth) {
    return texraAuth;
  }

  // 2. Check Authorization header (OpenAI style)
  const authHeader = req.headers.get('Authorization');
  if (authHeader) {
    // Handle "Bearer {token}" format
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    // Handle raw token
    return authHeader;
  }

  // 3. Check x-api-key (Anthropic style)
  const xApiKey = req.headers.get('x-api-key');
  if (xApiKey) {
    return xApiKey;
  }

  // 4. Check x-goog-api-key (Google style)
  const googApiKey = req.headers.get('x-goog-api-key');
  if (googApiKey) {
    return googApiKey;
  }

  return null;
}

// Path prefix constant for URL parsing
const RELAY_PATH_PREFIX = '/relay/';

/**
 * Get list of providers that have API keys configured.
 * Used by the /providers endpoint to inform clients which providers are available.
 */
function getEnabledProviders(): string[] {
  return Object.entries(PROVIDER_CONFIGS)
    .filter(([_, config]) => {
      const apiKey = Deno.env.get(config.envKey);
      return apiKey && apiKey.length > 0;
    })
    .map(([provider]) => provider);
}

/**
 * Parse the URL path to extract provider and API path.
 *
 * Format: /relay/{provider}/{...apiPath}
 * Note: Supabase Edge Functions receive paths like /functions/v1/relay/...
 */
function parseRequestPath(pathname: string): {
  provider: string;
  apiPath: string;
} | null {
  // Find /relay/ in the path (handles /functions/v1/relay/... prefix from Supabase)
  const relayIndex = pathname.indexOf(RELAY_PATH_PREFIX);
  if (relayIndex === -1) {
    return null;
  }

  // Extract everything after /relay/
  const withoutPrefix = pathname.substring(
    relayIndex + RELAY_PATH_PREFIX.length,
  );
  const parts = withoutPrefix.split('/');

  if (parts.length < 1 || !parts[0]) {
    return null;
  }

  const provider = parts[0].toLowerCase();
  const apiPath = '/' + parts.slice(1).join('/');
  return { provider, apiPath };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Handle /providers endpoint - returns list of providers with configured API keys
  // This is a public endpoint (no auth required) so clients know which providers
  // are available before attempting to use them.
  if (
    url.pathname.endsWith('/relay/providers') ||
    url.pathname === '/providers'
  ) {
    const enabledProviders = getEnabledProviders();
    return new Response(
      JSON.stringify({
        _relay: RELAY_VERSION,
        providers: enabledProviders,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  // Handle /tier-config endpoint - returns tier-based model access configuration
  // This is a public endpoint (no auth required) so clients can cache the config
  // and show appropriate UI (disabled models, upgrade prompts, etc.)
  if (
    url.pathname.endsWith('/relay/tier-config') ||
    url.pathname === '/tier-config'
  ) {
    return new Response(JSON.stringify(TIER_CONFIG), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    // 1. Parse the request path
    const parsed = parseRequestPath(url.pathname);
    if (!parsed) {
      return new Response(
        JSON.stringify({
          _relay: RELAY_VERSION,
          error: 'Invalid path. Expected: /relay/{provider}/{apiPath}',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const { provider, apiPath } = parsed;

    // 2. Validate provider
    const providerConfig = getProviderConfig(provider);
    if (!providerConfig) {
      return new Response(
        JSON.stringify({
          _relay: RELAY_VERSION,
          error: `Unsupported provider: ${provider}`,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // 3. Extract JWT token from headers
    const jwtToken = extractJwtFromRequest(req);
    if (!jwtToken) {
      return new Response(
        JSON.stringify({
          _relay: RELAY_VERSION,
          error: 'Missing authorization token',
        }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // 4. Validate user and check tier
    //
    // SECURITY MODEL:
    // - Use SUPABASE_ANON_KEY (not service role) so RLS policies apply
    // - Pass user's JWT in Authorization header for authentication
    // - auth.getUser() validates the JWT and returns the authenticated user
    // - Profile query is protected by RLS: users can only read their own profile
    //
    // This provides defense-in-depth: even if there's a bug in our filtering,
    // RLS prevents users from accessing other users' data.
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('Missing required Supabase environment variables');
      return new Response(
        JSON.stringify({
          _relay: RELAY_VERSION,
          error: 'Server configuration error',
        }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // Create client with the user's JWT for authentication
    // RLS policies will apply based on the authenticated user
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${jwtToken}` } },
    });

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return new Response(
        JSON.stringify({
          _relay: RELAY_VERSION,
          error: 'Invalid or expired token',
        }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // 5. Check user tier (Ultra or Max)
    const { data: profile, error: profileError } = await userClient
      .from('profiles')
      .select('tier')
      .eq('user_id', user.id)
      .single();

    if (profileError || !profile) {
      return new Response(
        JSON.stringify({
          _relay: RELAY_VERSION,
          error: 'Profile not found',
        }),
        {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // Default to 'free' if no tier is set (authenticated but no subscription)
    const userTier = profile.tier || FREE_TIER;

    // 5a. Check if provider is allowed for user's tier
    if (!isProviderAllowedForTier(userTier, provider)) {
      return new Response(
        JSON.stringify({
          _relay: RELAY_VERSION,
          error: `Provider '${provider}' is not available for ${userTier} tier`,
        }),
        {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // 5b. For non-Ultra tiers, validate the model is allowed
    // Ultra tier has unrestricted model access, but Max and free tiers
    // are limited to their respective model lists
    let requestBody: string | null = null;
    let modelName: string | null = null;

    if (userTier !== ULTRA_TIER && req.method !== 'GET') {
      // Read and clone the body
      requestBody = await req.text();

      try {
        const bodyJson = JSON.parse(requestBody);
        // Different providers use different field names for the model
        // OpenAI/Anthropic/most: "model"
        // Some may use other fields, but "model" is standard
        modelName = bodyJson.model || null;
      } catch {
        // If body is not JSON, can't extract model from body
      }

      // Fallback: extract model from URL path for providers that embed it there
      // Google GenAI SDK uses paths like /models/gemini-2.5-flash:generateContent
      if (!modelName) {
        modelName = extractModelFromPath(apiPath);
      }

      // Validate model is allowed for user's tier
      if (!isModelAllowedForTier(userTier, modelName)) {
        const tierName = userTier === FREE_TIER ? 'free' : userTier;
        const upgradeHint =
          userTier === FREE_TIER
            ? 'Upgrade to Max for more models.'
            : 'Upgrade to Ultra for access.';

        return new Response(
          JSON.stringify({
            _relay: RELAY_VERSION,
            error: modelName
              ? `Model '${modelName}' is not available for ${tierName} tier. ${upgradeHint}`
              : `Could not determine model from request. ${tierName} tier requires explicit model specification.`,
          }),
          {
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          },
        );
      }
    }

    // 6. Get server-side API key
    const apiKey = Deno.env.get(providerConfig.envKey);
    if (!apiKey) {
      console.error(`[RELAY] API key not configured: ${providerConfig.envKey}`);
      return new Response(
        JSON.stringify({
          _relay: RELAY_VERSION,
          error: `API key not configured for ${provider}`,
        }),
        {
          status: 503,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // 7. Build target URL (include query string if present)
    const targetUrl = `${providerConfig.baseUrl}${apiPath}${url.search}`;

    // 8. Prepare headers for upstream request
    // Forward all client headers except those we need to modify or skip
    const upstreamHeaders = new Headers();

    // Headers to skip (hop-by-hop, security-sensitive, or relay-specific)
    const SKIP_HEADERS = new Set([
      'host',
      'connection',
      'keep-alive',
      'transfer-encoding',
      'te',
      'trailer',
      'upgrade',
      'proxy-authorization',
      'proxy-connection',
      // Auth headers we'll replace with real API key
      'authorization',
      'x-api-key',
      'x-goog-api-key',
      // TeXRA-specific headers that shouldn't go upstream
      'x-texra-auth',
      'x-client-info',
      'apikey', // Supabase's anon key header
    ]);

    // Copy all client headers except the ones we skip
    req.headers.forEach((value, key) => {
      if (!SKIP_HEADERS.has(key.toLowerCase())) {
        upstreamHeaders.set(key, value);
      }
    });

    // Set auth header based on provider (replaces any client auth)
    if (providerConfig.authType === 'bearer') {
      upstreamHeaders.set('Authorization', `Bearer ${apiKey}`);
    } else if (providerConfig.authType === 'x-api-key') {
      upstreamHeaders.set('x-api-key', apiKey);
      // Ensure anthropic-version is set (required by Anthropic API)
      if (!upstreamHeaders.has('anthropic-version')) {
        upstreamHeaders.set('anthropic-version', '2023-06-01');
      }
    } else if (providerConfig.authType === 'x-goog-api-key') {
      upstreamHeaders.set('x-goog-api-key', apiKey);
    }

    // 9. Forward request to provider with timeout
    // Use 390s timeout to maximize compatibility with Supabase paid plans (400s wall clock limit)
    // Note: Free plans have 150s limit - thinking models may timeout on free tier
    const UPSTREAM_TIMEOUT_MS = 390000;
    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      UPSTREAM_TIMEOUT_MS,
    );

    let upstreamResponse: Response;
    try {
      // Use pre-read body for Max tier (we already consumed req.body for model validation)
      // For Ultra tier or GET requests, use the original request body
      const bodyToSend =
        req.method !== 'GET'
          ? requestBody !== null
            ? requestBody
            : req.body
          : undefined;

      upstreamResponse = await fetch(targetUrl, {
        method: req.method,
        headers: upstreamHeaders,
        body: bodyToSend,
        signal: abortController.signal,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        return new Response(
          JSON.stringify({
            _relay: RELAY_VERSION,
            error: 'Upstream request timed out',
          }),
          {
            status: 504,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          },
        );
      }
      throw error;
    }
    clearTimeout(timeoutId);

    // Log upstream errors server-side, but pass through original response to SDKs
    // This preserves the provider's error format (error.message, error.type, etc.)
    // so SDKs can parse and display meaningful error messages to users.
    if (upstreamResponse.status >= 400) {
      console.error(
        `[RELAY] Upstream error: ${provider} ${upstreamResponse.status}`,
      );
      // Pass through the original error response - don't wrap it
      // SDKs expect specific error formats (e.g., { error: { message: "...", type: "..." } })
    }

    // 10. Return response with CORS headers
    // Forward all response headers except hop-by-hop headers
    const responseHeaders = new Headers(corsHeaders);

    // Headers to skip in response (hop-by-hop or should not be forwarded)
    const SKIP_RESPONSE_HEADERS = new Set([
      'connection',
      'keep-alive',
      'transfer-encoding', // Let fetch handle this
      'te',
      'trailer',
      'upgrade',
    ]);

    // Copy all upstream response headers except the ones we skip
    upstreamResponse.headers.forEach((value, key) => {
      if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    // Disable buffering for streaming
    responseHeaders.set('X-Accel-Buffering', 'no');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    // Log full error server-side for debugging, but don't expose details to clients
    console.error('Relay error:', error);
    return new Response(
      JSON.stringify({
        _relay: RELAY_VERSION,
        error: 'Internal server error',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});
