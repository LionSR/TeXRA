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
 * The profiles table must have (all server-managed; clients have SELECT only):
 * - tier: text (values: 'Ultra', 'Max', 'free')
 * - access_expires_at: timestamptz (null = no expiration / lifetime access)
 * - banned_until: timestamptz, mirror of auth.users.banned_until via trigger
 *
 * To grant time-limited access (legitimate access window — NOT a ban):
 *   UPDATE profiles SET access_expires_at = NOW() + INTERVAL '90 days'
 *     WHERE user_id = '<user-id>';   -- service role only
 *
 * To BAN a user, use GoTrue's native ban (do NOT overload access_expires_at —
 * a future date there GRANTS access). Admin API:
 *   supabase.auth.admin.updateUserById(id, { ban_duration: '876000h' })
 * or the Dashboard "Ban user" action. That sets auth.users.banned_until and
 * revokes refresh tokens; the trigger mirrors it to profiles.banned_until,
 * which the relay enforces below (immediate, even for a still-valid token).
 * ============================================================================
 *
 * TIER HIERARCHY (model access):
 * - free: input <= $1.5/M AND output <= $9/M, excluding openai/anthropic/google
 * - Max: every model except openai/anthropic/google
 * - Ultra: every model, including openai/anthropic/google (Ultra-only via relay)
 *
 * Authentication: JWT tokens are extracted from SDK auth headers:
 * - OpenAI: Authorization: Bearer {jwt}
 * - Anthropic: x-api-key: {jwt}
 * - Google: x-goog-api-key: {jwt}
 *
 * The relay validates the JWT, checks user tier, then replaces it with the
 * real API key before forwarding to the upstream provider.
 *
 * CI relay tokens minted by `texra setup-token` (prefix `texra_relay_`,
 * validated hash-at-rest against relay_ci_tokens) are accepted in the same
 * headers and resolve to their owning user with identical tier, spending,
 * and rate enforcement.
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

import { Hono } from '@hono/hono';
import { cors } from '@hono/hono/cors';
import type { SupabaseClient } from '@supabase/supabase-js';
import { bearerToken } from '../_shared/auth.ts';
import {
  adminClient,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
} from '../_shared/edgeClients.ts';
import { resolveRelayCredential } from '../_shared/relayCiToken.ts';
import {
  PROVIDER_CONFIGS,
  TIER_CONFIG,
  TIER_SPENDING_LIMITS,
  getSpendingLimit,
  getRequestLimits,
  isRetiredModelRequest,
  isModelAllowedForTier,
  FREE_TIER_SUGGESTED_MODEL,
  ULTRA_ONLY_PROVIDER_SET,
  ULTRA_TIER,
  FREE_TIER,
  MAX_TIER,
} from './models.ts';
import {
  checkSpendingLimit,
  requireRelayEnforcementClient,
} from './enforcement.ts';
import { isJsonRecord } from './json.ts';
import {
  capOpenAIReasoningEffortForTier,
  type ReasoningEffortCap,
} from './reasoning.ts';
import {
  isModelFreeRelayPath,
  isRetiredGoogleGenerateContentPath,
} from './paths.ts';
import {
  clampFreeTierMaxOutputTokens,
  FREE_TIER_MAX_OUTPUT_TOKENS,
  formatRequestBytes,
  readRequestBodyWithinSizeLimit,
} from './requestLimits.ts';
import {
  classifyPreHeaderFailure,
  getRelayRequestBytes,
  getUpstreamRequestId,
  logRelayFailure,
  RELAY_REQUEST_ID_HEADER,
  withRelayErrorRequestId,
} from './diagnostics.ts';
import {
  acquireRelayRequestSlot,
  releaseRelaySlotSafely,
  releaseWhenStreamCloses,
} from './requestGate.ts';

// =============================================================================
// Constants
// =============================================================================

const RELAY_VERSION = '1.10.0';

// Tier constants imported from models.ts (single source of truth)
// CROSS-REFERENCE: Keep models.ts in sync with:
// - src/auth/config.ts: ULTRA_TIER, MAX_TIER, FREE_TIER constants
// - Database: profiles.tier column values

// Upstream request timeout (390s to fit within Supabase's 400s wall clock limit)
const UPSTREAM_TIMEOUT_MS = 390000;

const OPENAI_GPT5_REASONING_EFFORT_CAPS: Record<string, ReasoningEffortCap> = {
  [FREE_TIER]: 'medium',
  [MAX_TIER]: 'high',
};

// Hop-by-hop and auth headers stripped before forwarding to the upstream
// provider (auth is re-added from the server-side key).
const SKIP_REQUEST_HEADERS = new Set([
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
  'content-length',
  'x-api-key',
  'x-goog-api-key',
  'x-texra-auth',
  'x-client-info',
  'apikey',
]);

// Hop-by-hop headers stripped from the upstream response before returning it.
const SKIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
]);

// =============================================================================
// Types
// =============================================================================

type ProviderKey = keyof typeof PROVIDER_CONFIGS;

// =============================================================================
// Helper Functions
// =============================================================================

// Providers with a configured server-side API key. Env vars are fixed at
// cold start (secret changes restart every function), so this is computed
// once per isolate instead of on every /providers and /tier-config request.
const ENABLED_PROVIDERS: string[] = Object.entries(PROVIDER_CONFIGS)
  .filter(([, config]) => Deno.env.get(config.envKey))
  .map(([name]) => name);

function getEnabledProviders(): string[] {
  return ENABLED_PROVIDERS;
}

/**
 * Extract JWT token from request headers. SDKs use provider-specific headers
 * (OpenAI: Authorization: Bearer, Anthropic: x-api-key, Google:
 * x-goog-api-key), not just standard Authorization.
 */
function extractJwtFromRequest(req: Request): string | null {
  return (
    bearerToken(req) ||
    req.headers.get('x-api-key') ||
    req.headers.get('x-goog-api-key') ||
    null
  );
}

/**
 * Extract model names from provider paths that embed them, including Google's
 * `models/{model}:countTokens` route.
 */
function extractModelFromPath(apiPath: string): string | null {
  const match = apiPath.match(/^(?:\/v1(?:beta)?)?\/models\/([^:]+)/);
  return match ? match[1] : null;
}

/**
 * Fetch the profile columns the relay enforces (tier, expiry, ban state).
 * Shared by the public tier-config status check and the provider-proxy
 * enforcement path so the selected column list can't drift between them.
 */
function fetchRelayProfile(profileClient: SupabaseClient, userId: string) {
  return profileClient
    .from('profiles')
    .select('tier, access_expires_at, banned_until')
    .eq('user_id', userId)
    .single();
}

/** Milliseconds in one day */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

function isFutureTimestamp(
  timestamp: string | null | undefined,
  now = new Date(),
): boolean {
  if (timestamp == null) return false;
  if (timestamp === 'infinity') return true;
  if (timestamp === '-infinity') return false;

  const parsed = new Date(timestamp);
  return Number.isFinite(parsed.getTime()) && parsed > now;
}

// =============================================================================
// Hono App
// =============================================================================

export const app = new Hono().basePath('/relay');

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
    exposeHeaders: [
      'content-length',
      'content-type',
      'x-request-id',
      RELAY_REQUEST_ID_HEADER,
    ],
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
  const jwtToken = extractJwtFromRequest(c.req.raw);

  // Override static providers list with actually enabled providers
  // Include spending limits in the public config
  const config = {
    ...TIER_CONFIG,
    providers: getEnabledProviders(),
    spendingLimits: TIER_SPENDING_LIMITS,
  };

  // Try to include user status if authenticated (user JWT or CI relay token)
  if (jwtToken && SUPABASE_URL) {
    try {
      const credential = await resolveRelayCredential(jwtToken, adminClient);

      if (credential.ok) {
        const { userId, profileClient } = credential;
        const { data: profile } = await fetchRelayProfile(
          profileClient,
          userId,
        );

        if (profile) {
          const now = new Date();
          const tier = profile.tier || FREE_TIER;
          const accessExpiresAt: string | null =
            profile.access_expires_at || null;
          const daysRemaining =
            accessExpiresAt === null
              ? null
              : Math.ceil(
                  (new Date(accessExpiresAt).getTime() - now.getTime()) /
                    MS_PER_DAY,
                );
          const userStatus = {
            tier: profile.tier,
            accessExpiresAt,
            isExpired: daysRemaining !== null && daysRemaining <= 0,
            daysRemaining,
            isBanned: isFutureTimestamp(profile.banned_until, now),
          };

          const enforcement = requireRelayEnforcementClient(adminClient);
          const spending = enforcement.ok
            ? await checkSpendingLimit(enforcement.client, userId, tier)
            : {
                status: 'unavailable' as const,
                reason: enforcement.reason,
                limit: getSpendingLimit(tier),
              };

          if (spending.status === 'unavailable') {
            return c.json({
              ...config,
              userStatus,
              spendingStatus: null,
              spendingStatusError: {
                spendCheckFailed: true,
                failureReason: spending.reason,
                limit: spending.limit,
              },
            });
          }

          return c.json({
            ...config,
            userStatus,
            spendingStatus: {
              currentSpend: spending.currentSpend,
              limit: spending.limit,
              remaining: spending.remaining,
              percentUsed:
                spending.limit > 0
                  ? Math.round((spending.currentSpend / spending.limit) * 100)
                  : 100,
            },
          });
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
  const providerConfig = PROVIDER_CONFIGS[provider as ProviderKey] ?? null;
  if (!providerConfig) {
    return jsonError(`Unsupported provider: ${provider}`, 400);
  }
  if (provider === 'google' && isRetiredGoogleGenerateContentPath(apiPath)) {
    return jsonError(
      'Google Generate Content is no longer supported. Use the Interactions API.',
      410,
    );
  }

  // 2. Extract JWT token
  const jwtToken = extractJwtFromRequest(c.req.raw);
  if (!jwtToken) {
    return jsonError('Missing authorization token', 401);
  }

  // 3. Check Supabase config (authenticateJwt builds its own user-scoped client)
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('Missing required Supabase environment variables');
    return jsonError('Server configuration error', 500);
  }

  // 4. Require every privileged enforcement dependency before authentication
  // or server-side provider key use. Public metadata routes remain available.
  const enforcement = requireRelayEnforcementClient(adminClient);
  if (!enforcement.ok) {
    console.error(
      '[RELAY] Relay enforcement unavailable: service-role client missing',
    );
    return jsonError(
      'Relay enforcement is temporarily unavailable. Please try again shortly, or switch to your own API keys.',
      503,
      {
        enforcementUnavailable: true,
        failureReason: enforcement.reason,
      },
    );
  }
  const relayAdminClient = enforcement.client;

  // 5. Validate the credential: a normal user JWT, or a CI relay token
  // (texra setup-token) checked hash-at-rest against relay_ci_tokens. Both
  // resolve to the owning user id; everything below is identical.
  const credential = await resolveRelayCredential(jwtToken, relayAdminClient);
  if (!credential.ok) {
    return jsonError(credential.message, credential.status);
  }
  const { userId, profileClient } = credential;

  // 6. Get user profile and check ban / expiration
  const { data: profile, error: profileError } = await fetchRelayProfile(
    profileClient,
    userId,
  );

  if (profileError || !profile) {
    return jsonError('Profile not found', 403);
  }

  // Ban: profiles.banned_until mirrors GoTrue's auth.users.banned_until. GoTrue
  // already blocks sign-in/refresh for banned users, but a still-valid access
  // token would otherwise keep working until it expires — enforce it here so the
  // ban is immediate. Checked before tier/expiry so it can't be circumvented.
  const now = new Date();
  if (isFutureTimestamp(profile.banned_until, now)) {
    return jsonError(
      'Your account has been suspended. Contact support if you believe this is a mistake.',
      403,
      { banned: true },
    );
  }

  // Check if access has expired
  if (profile.access_expires_at) {
    const expiresAt = new Date(profile.access_expires_at);
    if (expiresAt < now) {
      return jsonError(
        'Your researcher access has expired. Please contact support to renew.',
        403,
        { expired: true, expiresAt: profile.access_expires_at },
      );
    }
  }

  const userTier = profile.tier || FREE_TIER;

  // 6.1. openai/anthropic/google are Ultra-only via relay: free/Max users can
  // still reach them with their own API keys, just not through relay's
  // server-side keys. Gated on the URL provider segment, not model name, so
  // it can't be bypassed by an unrecognized/future model string.
  if (userTier !== ULTRA_TIER && ULTRA_ONLY_PROVIDER_SET.has(provider)) {
    return jsonError(
      `Provider '${provider}' is only available on relay for the Ultra tier. ` +
        `Switch to your own API key for '${provider}', or upgrade to Ultra.`,
      403,
      { providerRestricted: true, provider, requiredTier: ULTRA_TIER },
    );
  }

  // 6.5. Check monthly spending limit
  const spending = await checkSpendingLimit(relayAdminClient, userId, userTier);
  if (spending.status === 'unavailable') {
    return jsonError(
      'Unable to verify your monthly relay usage right now. Please try again shortly, or switch to your own API keys.',
      503,
      {
        spendCheckFailed: true,
        failureReason: spending.reason,
        limit: spending.limit,
      },
    );
  }

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

  // 7. Apply retired-model and tier constraints for model endpoints.
  // Skip model validation for endpoints that don't require a model.
  const isModelFreePath = isModelFreeRelayPath(apiPath);

  let requestBody: string | Uint8Array | null = null;
  let requestBodyJson: unknown = null;
  let modelName: string | null = null;

  // Free relay users share one body-size boundary for all non-GET routes,
  // including upload endpoints that skip model validation.
  if (userTier === FREE_TIER && c.req.method !== 'GET') {
    const requestSize = await readRequestBodyWithinSizeLimit(c.req.raw.body);
    if (!requestSize.allowed) {
      return jsonError(
        `Free tier relay requests are limited to ${formatRequestBytes(requestSize.limitBytes)}. ` +
          `The relay stopped reading after ${formatRequestBytes(requestSize.requestBytes)}. ` +
          'Switch to your own API keys for larger requests.',
        413,
        {
          requestTooLarge: true,
          limitBytes: requestSize.limitBytes,
          requestBytes: requestSize.requestBytes,
        },
      );
    }
    requestBody = requestSize.body;
  }

  const isModelRequest = c.req.method !== 'GET' && !isModelFreePath;

  if (isModelRequest) {
    if (requestBody === null) {
      requestBody = await c.req.text();
    } else if (requestBody instanceof Uint8Array) {
      requestBody = new TextDecoder().decode(requestBody);
    }

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
  }

  if (modelName && isRetiredModelRequest(modelName)) {
    return jsonError(
      `Model '${modelName}' is retired and no longer available from its provider. Choose an active model.`,
      403,
    );
  }

  if (userTier !== ULTRA_TIER && isModelRequest) {
    if (!isModelAllowedForTier(userTier, modelName)) {
      // Point users at a model their tier can actually use, not just an upsell.
      const tierModelAccess =
        TIER_CONFIG.tiers[userTier as keyof typeof TIER_CONFIG.tiers];
      const suggestedModelAllowed = Array.isArray(tierModelAccess?.models)
        ? tierModelAccess.models.includes(FREE_TIER_SUGGESTED_MODEL)
        : tierModelAccess?.models === '*';
      const hint = suggestedModelAllowed
        ? `Switch to an available model such as '${FREE_TIER_SUGGESTED_MODEL}', or upgrade for access.`
        : 'Upgrade to Ultra for access.';

      return jsonError(
        modelName
          ? `Model '${modelName}' is not available for the ${userTier} tier. ${hint}`
          : `Could not determine model from request. The ${userTier} tier requires explicit model specification.`,
        403,
      );
    }

    if (userTier === FREE_TIER && !isJsonRecord(requestBodyJson)) {
      return jsonError(
        'Free tier relay requests to model endpoints must use a JSON object body so server-side limits can be enforced.',
        400,
        { invalidRequestBody: true },
      );
    }

    let cappedBody = capOpenAIReasoningEffortForTier(requestBodyJson, {
      provider,
      tier: userTier,
      modelName,
      tierCaps: OPENAI_GPT5_REASONING_EFFORT_CAPS,
    });
    if (userTier === FREE_TIER) {
      const outputClamp = clampFreeTierMaxOutputTokens(
        provider,
        apiPath,
        cappedBody,
      );
      if (outputClamp.changed) {
        console.info(
          `[RELAY] Free tier ${outputClamp.fieldPath} capped at ${FREE_TIER_MAX_OUTPUT_TOKENS} tokens` +
            (outputClamp.originalValue === null
              ? ''
              : ` (was ${outputClamp.originalValue})`),
        );
        cappedBody = outputClamp.body;
      }
    }
    if (cappedBody !== requestBodyJson) {
      requestBody = JSON.stringify(cappedBody);
    }
  }

  // 8. Get server-side API key
  const apiKey = Deno.env.get(providerConfig.envKey);
  if (!apiKey) {
    console.error(`[RELAY] API key not configured: ${providerConfig.envKey}`);
    return jsonError(`API key not configured for ${provider}`, 503);
  }

  // 8.5. Enforce server-side per-user request gates. This lives after local
  // request validation so rejected requests do not consume active slots.
  let releaseRelaySlot: (() => Promise<void>) | null = null;
  let refreshRelaySlot: (() => Promise<void>) | null = null;
  try {
    const slot = await acquireRelayRequestSlot(
      relayAdminClient,
      userId,
      getRequestLimits(userTier),
    );
    if (!slot.allowed) {
      const decision = slot.decision;
      if (decision.reason === 'concurrency') {
        return jsonError(
          `Too many concurrent relay requests. Limit: ${decision.concurrencyLimit ?? 'unknown'}.`,
          429,
          {
            requestLimitReached: true,
            reason: 'concurrency',
            activeRequests: decision.activeRequests,
            concurrencyLimit: decision.concurrencyLimit,
            retryAfterSeconds: decision.retryAfterSeconds,
          },
        );
      }
      return jsonError(
        `Relay request rate limit reached. Limit: ${decision.rateLimitPerMinute ?? 'unknown'} requests per minute.`,
        429,
        {
          requestLimitReached: true,
          reason: 'rate',
          requestsThisMinute: decision.requestsThisMinute,
          rateLimitPerMinute: decision.rateLimitPerMinute,
          retryAfterSeconds: decision.retryAfterSeconds,
        },
      );
    }
    releaseRelaySlot = slot.release;
    refreshRelaySlot = slot.refresh;
  } catch (error) {
    console.error('[RELAY] Failed to enforce request gate:', error);
    return jsonError(
      'Unable to verify relay request limits right now. Please try again shortly, or switch to your own API keys.',
      503,
      { requestLimitCheckFailed: true },
    );
  }

  // 9. Build target URL
  const url = new URL(c.req.url);
  const targetUrl = `${providerConfig.baseUrl}${apiPath}${url.search}`;

  // 10. Prepare upstream headers
  const upstreamHeaders = new Headers();
  c.req.raw.headers.forEach((value, key) => {
    if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) {
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

  // 11. Forward request with timeout
  let upstreamResponse: Response;
  const bodyToSend =
    c.req.method === 'GET' ? undefined : (requestBody ?? c.req.raw.body);
  const relayRequestId = crypto.randomUUID();
  const requestBytes = getRelayRequestBytes(
    bodyToSend,
    c.req.raw.headers.get('content-length'),
  );
  const upstreamStartedAt = performance.now();
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: c.req.method,
      headers: upstreamHeaders,
      // The buffered body owns its ArrayBuffer, although its existing public
      // type predates typed-array buffer generics in newer TypeScript versions.
      body: bodyToSend as BodyInit | null | undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const failurePhase = classifyPreHeaderFailure(error);
    logRelayFailure({
      relayRequestId,
      provider,
      model: modelName,
      requestBytes,
      elapsedMs: Math.round(performance.now() - upstreamStartedAt),
      failurePhase,
      upstreamRequestId: null,
    });
    await releaseRelaySlotSafely(releaseRelaySlot);
    if (failurePhase === 'pre_headers_timeout') {
      return withRelayErrorRequestId(
        jsonError('Upstream request timed out', 504),
        relayRequestId,
      );
    }
    return withRelayErrorRequestId(
      jsonError('Internal server error', 500),
      relayRequestId,
    );
  }

  const upstreamRequestId = getUpstreamRequestId(upstreamResponse.headers);

  if (upstreamResponse.status >= 400) {
    console.error(
      `[RELAY] Upstream error: ${provider} ${upstreamResponse.status}`,
    );
  }

  // 12. Forward response with headers
  const responseHeaders = new Headers();
  upstreamResponse.headers.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  responseHeaders.set('X-Accel-Buffering', 'no');
  responseHeaders.set(RELAY_REQUEST_ID_HEADER, relayRequestId);

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

  const responseBody = releaseRelaySlot
    ? await releaseWhenStreamCloses(
        upstreamResponse.body,
        releaseRelaySlot,
        refreshRelaySlot ?? undefined,
        () => {
          logRelayFailure({
            relayRequestId,
            provider,
            model: modelName,
            requestBytes,
            elapsedMs: Math.round(performance.now() - upstreamStartedAt),
            failurePhase: 'response_body_failure',
            upstreamRequestId,
          });
        },
      )
    : upstreamResponse.body;

  return new Response(responseBody, {
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

if (import.meta.main) {
  Deno.serve(app.fetch);
}
