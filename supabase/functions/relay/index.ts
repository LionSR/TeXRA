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
 * DATABASE REQUIREMENTS:
 * The profiles table must have:
 * - tier: text (values: 'Ultra', 'Max', 'free')
 * - access_expires_at: timestamptz (null = no expiration / lifetime access)
 *
 * To add expiration column:
 *   ALTER TABLE profiles ADD COLUMN access_expires_at timestamptz;
 *
 * To expire/blacklist a user:
 *   UPDATE profiles SET access_expires_at = NOW() WHERE id = '<user-id>';
 *
 * To grant time-limited access:
 *   UPDATE profiles SET access_expires_at = NOW() + INTERVAL '90 days' WHERE id = '<user-id>';
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
 * Supported providers: openai, anthropic, google, xai, deepseek, moonshot, dashscope, minimax, glm
 *
 * IMPORTANT: Deploy with --no-verify-jwt flag since we validate JWTs manually
 * (SDKs send JWT in provider-specific headers, not the standard Authorization header).
 */

import { Hono } from 'jsr:@hono/hono@4.12.15';
import { cors } from 'jsr:@hono/hono@4.12.15/cors';
import { createClient } from 'jsr:@supabase/supabase-js@2.104.1';
import {
  TIER_CONFIG,
  TIER_SPENDING_LIMITS,
  isModelAllowedForTier,
  getSpendingLimit,
  ULTRA_TIER,
  FREE_TIER,
} from './models.ts';
import { capOpenAIReasoningEffortForTier } from './reasoning.ts';

// =============================================================================
// Constants
// =============================================================================

const RELAY_VERSION = '1.9.0';

// Tier constants imported from models.ts (single source of truth)
// CROSS-REFERENCE: Keep models.ts in sync with:
// - src/auth/config.ts: ULTRA_TIER, MAX_TIER, FREE_TIER constants
// - Database: profiles.tier column values

// Upstream request timeout (390s to fit within Supabase's 400s wall clock limit)
const UPSTREAM_TIMEOUT_MS = 390000;

// =============================================================================
// Types
// =============================================================================

type AuthType = 'bearer' | 'x-api-key' | 'x-goog-api-key';

interface ProviderConfig {
  baseUrl: string;
  envKey: string;
  authType: AuthType;
}

type ProviderKey =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'moonshot'
  | 'dashscope'
  | 'minimax'
  | 'glm';

type JsonRecord = Record<string, unknown>;

// =============================================================================
// Provider Configuration
// =============================================================================

const PROVIDER_CONFIGS: Record<ProviderKey, ProviderConfig> = {
  openai: {
    baseUrl: 'https://api.openai.com',
    envKey: 'OPENAI_API_KEY',
    authType: 'bearer',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    envKey: 'ANTHROPIC_API_KEY',
    authType: 'x-api-key',
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    envKey: 'GOOGLE_API_KEY',
    authType: 'x-goog-api-key',
  },
  xai: {
    baseUrl: 'https://api.x.ai',
    envKey: 'XAI_API_KEY',
    authType: 'bearer',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    envKey: 'DEEPSEEK_API_KEY',
    authType: 'bearer',
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.cn',
    envKey: 'MOONSHOT_API_KEY',
    authType: 'bearer',
  },
  dashscope: {
    baseUrl: 'https://dashscope-intl.aliyuncs.com',
    envKey: 'DASHSCOPE_API_KEY',
    authType: 'bearer',
  },
  minimax: {
    baseUrl: 'https://api.minimax.io',
    envKey: 'MINIMAX_API_KEY',
    authType: 'bearer',
  },
  glm: {
    baseUrl: 'https://api.z.ai',
    envKey: 'GLM_API_KEY',
    authType: 'bearer',
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

function getProviderConfig(provider: string): ProviderConfig | null {
  return PROVIDER_CONFIGS[provider as ProviderKey] || null;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getEnabledProviders(): string[] {
  return Object.entries(PROVIDER_CONFIGS)
    .filter(([, config]) => Deno.env.get(config.envKey))
    .map(([name]) => name);
}

/**
 * Extract JWT token from request headers.
 * SDKs use provider-specific headers, not standard Authorization.
 */
function extractJwtFromRequest(req: Request): string | null {
  // OpenAI SDK: Authorization: Bearer {jwt}
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Anthropic SDK: x-api-key: {jwt}
  const anthropicKey = req.headers.get('x-api-key');
  if (anthropicKey) {
    return anthropicKey;
  }

  // Google SDK: x-goog-api-key: {jwt}
  const googleKey = req.headers.get('x-goog-api-key');
  if (googleKey) {
    return googleKey;
  }

  return null;
}

/**
 * Extract model name from URL path for providers that embed it there.
 * Google GenAI SDK uses paths like /models/gemini-2.5-flash:generateContent
 * or /v1beta/models/gemini-2.5-flash:generateContent
 */
function extractModelFromPath(apiPath: string): string | null {
  const match = apiPath.match(/^(?:\/v1(?:beta)?)?\/models\/([^:]+)/);
  return match ? match[1] : null;
}

/** Milliseconds in one day */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Calculate access status for a user based on their tier and expiration date.
 */
function calculateAccessStatus(
  tier: string | null,
  accessExpiresAt: string | null,
): {
  tier: string | null;
  accessExpiresAt: string | null;
  isExpired: boolean;
  daysRemaining: number | null;
} {
  if (!accessExpiresAt) {
    return {
      tier,
      accessExpiresAt: null,
      isExpired: false,
      daysRemaining: null,
    };
  }

  const daysRemaining = Math.ceil(
    (new Date(accessExpiresAt).getTime() - Date.now()) / MS_PER_DAY,
  );

  return {
    tier,
    accessExpiresAt,
    isExpired: daysRemaining <= 0,
    daysRemaining,
  };
}

/**
 * Create a JSON error response with relay metadata.
 *
 * Uses nested error format compatible with both OpenAI and Anthropic SDKs.
 * SDKs extract the `error` object, preserving the `_relay` field for
 * relay error detection (isRelayError checks for _relay in rawErrorBody).
 *
 * Format: { type: "error", error: { _relay, type, message, ...extra } }
 */
function jsonError(
  message: string,
  status: number,
  extra?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: {
        _relay: RELAY_VERSION,
        type: 'relay_error',
        message,
        ...extra,
      },
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

/**
 * Get the start of the current month in UTC.
 * Uses UTC for consistency with billing views.
 */
function getCurrentMonthStartUTC(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
}

/**
 * Check if user has exceeded their monthly spending limit.
 * Returns { allowed: true } or { allowed: false, currentSpend, limit, remaining }.
 *
 * Uses database function for server-side aggregation (efficient).
 *
 * RACE CONDITION NOTE: Usage is logged asynchronously after requests complete.
 * Concurrent requests may pass this check before their costs are logged.
 * This is acceptable for soft limits. See migration for mitigation options.
 */
async function checkSpendingLimit(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  tier: string,
): Promise<{
  allowed: boolean;
  currentSpend: number;
  limit: number;
  remaining: number;
}> {
  const limit = getSpendingLimit(tier);
  const monthStart = getCurrentMonthStartUTC();

  // Use service role to bypass RLS for admin query
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Call database function for efficient server-side aggregation
  // Aggregates relay usage server-side, summing workflow streams and
  // deduplicating other streams/batches; keep in sync with
  // 20260108_dedupe_relay_views_by_stream.sql.
  const { data, error } = await adminClient.rpc(
    'get_user_monthly_relay_spend',
    {
      p_user_id: userId,
      p_month_start: monthStart,
    },
  );

  if (error) {
    console.error('[RELAY] Failed to check spending:', error.message);
    // Fail open: allow request on error but log it
    return { allowed: true, currentSpend: 0, limit, remaining: limit };
  }

  const currentSpend = Number(data) || 0;
  const remaining = Math.max(0, limit - currentSpend);

  return {
    allowed: currentSpend < limit,
    currentSpend,
    limit,
    remaining,
  };
}

// =============================================================================
// Hono App
// =============================================================================

const app = new Hono().basePath('/relay');

// CORS middleware
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'authorization',
      'x-api-key',
      'x-goog-api-key',
      'x-client-info',
      'apikey',
      'content-type',
      'anthropic-version',
      'anthropic-beta',
      'x-stainless-lang',
      'x-stainless-package-version',
      'x-stainless-os',
      'x-stainless-arch',
      'x-stainless-runtime',
      'x-stainless-runtime-version',
    ],
    exposeHeaders: ['content-length', 'content-type', 'x-request-id'],
    maxAge: 86400,
  }),
);

// =============================================================================
// Public Routes
// =============================================================================

/**
 * GET /relay/providers - List of providers with configured API keys
 */
app.get('/providers', (c) => {
  return c.json({ _relay: RELAY_VERSION, providers: getEnabledProviders() });
});

/**
 * GET /relay/tier-config - Tier-based model access configuration
 * Returns enabled providers (with API keys) instead of all supported providers.
 * When authenticated, also includes user's access status and spending info.
 */
app.get('/tier-config', async (c) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const jwtToken = extractJwtFromRequest(c.req.raw);

  // Override static providers list with actually enabled providers
  // Include spending limits in the public config
  const config = {
    ...TIER_CONFIG,
    providers: getEnabledProviders(),
    spendingLimits: TIER_SPENDING_LIMITS,
  };

  // Try to include user status if authenticated
  if (jwtToken && supabaseUrl && supabaseAnonKey) {
    try {
      const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${jwtToken}` } },
      });

      const {
        data: { user },
      } = await supabaseClient.auth.getUser();

      if (user) {
        const { data: profile } = await supabaseClient
          .from('profiles')
          .select('tier, access_expires_at')
          .eq('user_id', user.id)
          .single();

        if (profile) {
          const userStatus = calculateAccessStatus(
            profile.tier,
            profile.access_expires_at,
          );

          // Include current spending if service role key is available
          let spendingStatus = null;
          if (serviceRoleKey) {
            const spending = await checkSpendingLimit(
              supabaseUrl,
              serviceRoleKey,
              user.id,
              profile.tier || FREE_TIER,
            );
            spendingStatus = {
              currentSpend: spending.currentSpend,
              limit: spending.limit,
              remaining: spending.remaining,
              percentUsed:
                spending.limit > 0
                  ? Math.round((spending.currentSpend / spending.limit) * 100)
                  : 100,
            };
          }

          return c.json({ ...config, userStatus, spendingStatus });
        }
      }
    } catch {
      // Fall through to public response
    }
  }

  return c.json(config);
});

// =============================================================================
// Provider Proxy Route
// =============================================================================

/**
 * ALL /relay/:provider/* - Proxy requests to upstream providers
 */
app.all('/:provider{[^/]+}/*', async (c) => {
  const provider = c.req.param('provider').toLowerCase();
  const apiPath = '/' + c.req.path.split('/').slice(3).join('/');

  // 1. Validate provider
  const providerConfig = getProviderConfig(provider);
  if (!providerConfig) {
    return jsonError(`Unsupported provider: ${provider}`, 400);
  }

  // 2. Extract JWT token
  const jwtToken = extractJwtFromRequest(c.req.raw);
  if (!jwtToken) {
    return jsonError('Missing authorization token', 401);
  }

  // 3. Get Supabase config
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Missing required Supabase environment variables');
    return jsonError('Server configuration error', 500);
  }

  // 4. Validate user and check tier
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${jwtToken}` } },
  });

  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();

  if (userError || !user) {
    return jsonError('Invalid or expired token', 401);
  }

  // 5. Get user profile and check expiration
  const { data: profile, error: profileError } = await userClient
    .from('profiles')
    .select('tier, access_expires_at')
    .eq('user_id', user.id)
    .single();

  if (profileError || !profile) {
    return jsonError('Profile not found', 403);
  }

  // Check if access has expired
  if (profile.access_expires_at) {
    const expiresAt = new Date(profile.access_expires_at);
    if (expiresAt < new Date()) {
      return jsonError(
        'Your researcher access has expired. Please contact support to renew.',
        403,
        { expired: true, expiresAt: profile.access_expires_at },
      );
    }
  }

  const userTier = profile.tier || FREE_TIER;

  // 5.5. Check monthly spending limit
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (serviceRoleKey) {
    const spending = await checkSpendingLimit(
      supabaseUrl,
      serviceRoleKey,
      user.id,
      userTier,
    );

    if (!spending.allowed) {
      return jsonError(
        `Monthly spending limit reached ($${spending.limit}). ` +
          `Current usage: $${spending.currentSpend.toFixed(2)}. ` +
          'You can continue using your own API keys, or wait for next month.',
        429,
        {
          limitReached: true,
          currentSpend: spending.currentSpend,
          limit: spending.limit,
          remaining: spending.remaining,
        },
      );
    }
  }

  // 6. Validate model for non-Ultra tiers
  // Skip model validation for endpoints that don't require a model (e.g., file uploads)
  // - OpenAI: /v1/files
  // - Anthropic: /v1/files (same as OpenAI)
  // - Google: /upload/*, /v1beta/files
  const MODEL_FREE_PATHS = ['/v1/files', '/files', '/upload', '/v1beta/files'];
  const isModelFreePath = MODEL_FREE_PATHS.some(
    (prefix) => apiPath === prefix || apiPath.startsWith(prefix + '/'),
  );

  let requestBody: string | null = null;
  let requestBodyJson: unknown = null;
  let modelName: string | null = null;

  if (userTier !== ULTRA_TIER && c.req.method !== 'GET' && !isModelFreePath) {
    requestBody = await c.req.text();

    try {
      requestBodyJson = JSON.parse(requestBody);
      modelName =
        isJsonRecord(requestBodyJson) &&
        typeof requestBodyJson.model === 'string'
          ? requestBodyJson.model
          : null;
    } catch {
      // Not JSON, try extracting from path
    }

    if (!modelName) {
      modelName = extractModelFromPath(apiPath);
    }

    if (!isModelAllowedForTier(userTier, modelName)) {
      const tierName = userTier === FREE_TIER ? 'free' : userTier;
      const upgradeHint = 'Upgrade to Ultra for access.';

      return jsonError(
        modelName
          ? `Model '${modelName}' is not available for ${tierName} tier. ${upgradeHint}`
          : `Could not determine model from request. ${tierName} tier requires explicit model specification.`,
        403,
      );
    }

    const cappedBody = capOpenAIReasoningEffortForTier(requestBodyJson, {
      provider,
      tier: userTier,
      modelName,
    });
    if (cappedBody !== requestBodyJson) {
      requestBody = JSON.stringify(cappedBody);
    }
  }

  // 7. Get server-side API key
  const apiKey = Deno.env.get(providerConfig.envKey);
  if (!apiKey) {
    console.error(`[RELAY] API key not configured: ${providerConfig.envKey}`);
    return jsonError(`API key not configured for ${provider}`, 503);
  }

  // 8. Build target URL
  const url = new URL(c.req.url);
  const targetUrl = `${providerConfig.baseUrl}${apiPath}${url.search}`;

  // 9. Prepare upstream headers
  const upstreamHeaders = new Headers();
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
    'authorization',
    'x-api-key',
    'x-goog-api-key',
    'x-texra-auth',
    'x-client-info',
    'apikey',
  ]);

  c.req.raw.headers.forEach((value, key) => {
    if (!SKIP_HEADERS.has(key.toLowerCase())) {
      upstreamHeaders.set(key, value);
    }
  });

  // Set auth header based on provider
  if (providerConfig.authType === 'bearer') {
    upstreamHeaders.set('Authorization', `Bearer ${apiKey}`);
  } else if (providerConfig.authType === 'x-api-key') {
    upstreamHeaders.set('x-api-key', apiKey);
    if (!upstreamHeaders.has('anthropic-version')) {
      upstreamHeaders.set('anthropic-version', '2023-06-01');
    }
  } else if (providerConfig.authType === 'x-goog-api-key') {
    upstreamHeaders.set('x-goog-api-key', apiKey);
  }

  // 10. Forward request with timeout
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    UPSTREAM_TIMEOUT_MS,
  );

  let upstreamResponse: Response;
  try {
    const bodyToSend =
      c.req.method !== 'GET'
        ? requestBody !== null
          ? requestBody
          : c.req.raw.body
        : undefined;

    upstreamResponse = await fetch(targetUrl, {
      method: c.req.method,
      headers: upstreamHeaders,
      body: bodyToSend,
      signal: abortController.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      return jsonError('Upstream request timed out', 504);
    }
    throw error;
  }
  clearTimeout(timeoutId);

  if (upstreamResponse.status >= 400) {
    console.error(
      `[RELAY] Upstream error: ${provider} ${upstreamResponse.status}`,
    );
  }

  // 11. Forward response with headers
  const responseHeaders = new Headers();
  const SKIP_RESPONSE_HEADERS = new Set([
    'connection',
    'keep-alive',
    'transfer-encoding',
    'te',
    'trailer',
    'upgrade',
  ]);

  upstreamResponse.headers.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  responseHeaders.set('X-Accel-Buffering', 'no');

  // FUTURE: SSE keepalive injection to prevent proxy idle timeouts.
  //
  // Extended thinking emits deltas at a much lower rate than text generation.
  // Gaps between SSE events can exceed intermediate proxy idle timeouts
  // (e.g. Cloudflare ~100s), causing the proxy to drop the connection and
  // truncate the stream. Injecting periodic SSE comments (`: keepalive\n\n`)
  // would keep data flowing, since parsers ignore comment lines.
  //
  // A previous setInterval-based approach was removed because the timer could
  // fire mid-chunk, injecting `: keepalive\n\n` between two halves of a split
  // SSE event and corrupting the stream. A safe implementation would need to:
  //   1. Track whether the last forwarded chunk ended on an event boundary
  //      (i.e. ended with `\n\n`), and only inject keepalives at clean boundaries.
  //   2. Or use a pull-based approach that emits a keepalive only when the
  //      upstream read has been pending longer than the threshold, ensuring
  //      no interleaving with real data.
  //
  // The client-side AnthropicStreamHandler already detects truncated streams
  // via the `messageStopReceived` diagnostic and throws a retryable error,
  // so the impact of not having keepalives is a retry, not silent data loss.

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
});

// =============================================================================
// Error Handler & Export
// =============================================================================

app.onError((err, _c) => {
  console.error('Relay error:', err);
  return jsonError('Internal server error', 500);
});

// Handle requests that don't match /relay/* base path
app.notFound((_c) => {
  return jsonError('Invalid path. Expected: /relay/{provider}/{apiPath}', 400);
});

Deno.serve(app.fetch);
