/**
 * Relay Edge Function - Server-side API key proxy for Ultra users.
 *
 * This function acts as a transparent proxy for AI API requests, allowing Ultra
 * tier users to access AI models without providing their own API keys.
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
 * - POST /relay/{provider}/{...path} - Proxy request to provider (requires Ultra tier)
 *
 * Example: /relay/openai/v1/chat/completions
 *
 * Supported providers: openai, anthropic, google, xai, deepseek, moonshot, dashscope
 *
 * IMPORTANT: Deploy with --no-verify-jwt flag since we validate JWTs manually
 * (SDKs send JWT in provider-specific headers, not the standard Authorization header).
 */

// Relay version for debugging deployments
const RELAY_VERSION = '1.3.1';

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

    // 5. Check user tier is Ultra
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

    if (profile.tier !== 'Ultra') {
      return new Response(
        JSON.stringify({
          _relay: RELAY_VERSION,
          error: 'Ultra tier required for server-side API keys',
        }),
        {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
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
    // Use 2 minute timeout to accommodate streaming responses
    const UPSTREAM_TIMEOUT_MS = 120000;
    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      UPSTREAM_TIMEOUT_MS,
    );

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(targetUrl, {
        method: req.method,
        headers: upstreamHeaders,
        body: req.method !== 'GET' ? req.body : undefined,
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
