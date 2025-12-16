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
 * URL Structure: /relay/{provider}/{...path}
 * Example: /relay/openai/v1/chat/completions
 *
 * Supported providers: openai, anthropic, google, xai, deepseek, moonshot, dashscope
 *
 * IMPORTANT: Deploy with --no-verify-jwt flag since we validate JWTs manually
 * (SDKs send JWT in provider-specific headers, not the standard Authorization header).
 */

// Relay version for debugging deployments
const RELAY_VERSION = '1.1.0';

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
const PROVIDER_CONFIGS: Record<
  string,
  {
    baseUrl: string;
    authType: 'bearer' | 'x-api-key' | 'x-goog-api-key';
    envKey: string;
  }
> = {
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

// CORS headers
// Note: VS Code extensions make requests from the extension host (Node.js process),
// not from a browser context, so Origin headers aren't typically present.
// The wildcard is used for:
// 1. Development/testing scenarios
// 2. Webview contexts (which have origins like vscode-webview://*)
// Security is enforced via JWT validation, not CORS origin checking.
// TODO: Consider restricting to specific origins in production if needed.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-api-key, x-goog-api-key, x-texra-auth, x-client-info, apikey, content-type, anthropic-version, anthropic-beta, x-stainless-lang, x-stainless-package-version, x-stainless-os, x-stainless-arch, x-stainless-runtime, x-stainless-runtime-version',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

/**
 * Extract JWT token from request.
 *
 * SDKs send their credentials in provider-specific headers. When the user's JWT
 * is passed as the "apiKey" to the SDK, it arrives here in these headers.
 *
 * Priority order:
 * 1. Query parameter: ?texra_token={token} (fallback for edge cases)
 * 2. Custom header: x-texra-auth: {token} (explicit TeXRA auth)
 * 3. Authorization: Bearer {token} (OpenAI SDK)
 * 4. x-api-key: {token} (Anthropic SDK)
 * 5. x-goog-api-key: {token} (Google SDK)
 */
function extractJwtFromRequest(req: Request, url: URL): string | null {
  // 1. Check query parameter (fallback for edge cases)
  const queryToken = url.searchParams.get('texra_token');
  if (queryToken) {
    return queryToken;
  }

  // 2. Check custom TeXRA auth header (SDKs shouldn't interfere with this)
  const texraAuth = req.headers.get('x-texra-auth');
  if (texraAuth) {
    return texraAuth;
  }

  // 3. Check Authorization header (OpenAI style)
  const authHeader = req.headers.get('Authorization');
  if (authHeader) {
    // Handle "Bearer {token}" format
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    // Handle raw token
    return authHeader;
  }

  // 4. Check x-api-key (Anthropic style)
  const xApiKey = req.headers.get('x-api-key');
  if (xApiKey) {
    return xApiKey;
  }

  // 5. Check x-goog-api-key (Google style)
  const googApiKey = req.headers.get('x-goog-api-key');
  if (googApiKey) {
    return googApiKey;
  }

  return null;
}

/**
 * Parse the URL path to extract provider, optional path-embedded token, and API path.
 *
 * Supported formats:
 * 1. /relay/{provider}/{...apiPath} - token from query param or headers
 * 2. /relay/{provider}/-/{token}/{...apiPath} - token embedded in path (for SDKs that strip headers)
 *
 * The /-/ separator indicates a path-embedded token follows.
 * Note: Supabase Edge Functions receive paths like /functions/v1/relay/...
 */
function parseRequestPath(pathname: string): {
  provider: string;
  apiPath: string;
  pathToken?: string;
} | null {
  // Find /relay/ in the path (handles /functions/v1/relay/... prefix from Supabase)
  const relayIndex = pathname.indexOf('/relay/');
  if (relayIndex === -1) {
    return null;
  }

  // Extract everything after /relay/
  const withoutPrefix = pathname.substring(relayIndex + 7); // 7 = '/relay/'.length
  const parts = withoutPrefix.split('/');

  if (parts.length < 1 || !parts[0]) {
    return null;
  }

  const provider = parts[0].toLowerCase();

  // Check if token is embedded in path: /relay/{provider}/-/{token}/{...apiPath}
  if (parts.length >= 3 && parts[1] === '-') {
    const pathToken = parts[2];
    const apiPath = '/' + parts.slice(3).join('/');
    return { provider, apiPath, pathToken };
  }

  // Standard format: /relay/{provider}/{...apiPath}
  const apiPath = '/' + parts.slice(1).join('/');
  return { provider, apiPath };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // 1. Parse the request path
    const parsed = parseRequestPath(url.pathname);
    if (!parsed) {
      return new Response(
        JSON.stringify({
          error: 'Invalid path. Expected: /relay/{provider}/{apiPath}',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const { provider, apiPath, pathToken } = parsed;

    // 2. Validate provider
    const providerConfig = PROVIDER_CONFIGS[provider];
    if (!providerConfig) {
      return new Response(
        JSON.stringify({ error: `Unsupported provider: ${provider}` }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // 3. Extract JWT token - path-embedded token has highest priority
    // Path token is most reliable since SDKs cannot modify the URL path structure
    const jwtToken = pathToken || extractJwtFromRequest(req, url);
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
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Missing required Supabase environment variables');
      return new Response(
        JSON.stringify({ error: 'Server configuration error' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // Create client with the extracted JWT in Authorization header format
    const userClient = createClient(supabaseUrl, serviceRoleKey, {
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
      return new Response(JSON.stringify({ error: 'Profile not found' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (profile.tier !== 'Ultra') {
      return new Response(
        JSON.stringify({
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
    const upstreamHeaders = new Headers();

    // Copy content-type
    const contentType = req.headers.get('Content-Type');
    if (contentType) {
      upstreamHeaders.set('Content-Type', contentType);
    }

    // Set auth header based on provider
    if (providerConfig.authType === 'bearer') {
      upstreamHeaders.set('Authorization', `Bearer ${apiKey}`);
    } else if (providerConfig.authType === 'x-api-key') {
      upstreamHeaders.set('x-api-key', apiKey);
      // Copy anthropic-specific headers
      const anthropicVersion = req.headers.get('anthropic-version');
      if (anthropicVersion) {
        upstreamHeaders.set('anthropic-version', anthropicVersion);
      } else {
        upstreamHeaders.set('anthropic-version', '2023-06-01');
      }
      const anthropicBeta = req.headers.get('anthropic-beta');
      if (anthropicBeta) {
        upstreamHeaders.set('anthropic-beta', anthropicBeta);
      }
    } else if (providerConfig.authType === 'x-goog-api-key') {
      upstreamHeaders.set('x-goog-api-key', apiKey);
    }

    // Copy Accept header
    const acceptHeader = req.headers.get('Accept');
    if (acceptHeader) {
      upstreamHeaders.set('Accept', acceptHeader);
    }

    // 9. Forward request to provider
    const upstreamResponse = await fetch(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: req.method !== 'GET' ? req.body : undefined,
    });

    // If error response, wrap with relay metadata for debugging
    if (upstreamResponse.status >= 400) {
      const errorBody = await upstreamResponse.text();
      console.error(
        `[RELAY] Upstream error: ${provider} ${upstreamResponse.status}`,
      );
      return new Response(
        JSON.stringify({
          _relay: RELAY_VERSION,
          error: 'Upstream API error',
          upstreamStatus: upstreamResponse.status,
          upstreamError: errorBody,
        }),
        {
          status: upstreamResponse.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // 10. Return response with CORS headers
    const responseHeaders = new Headers(corsHeaders);

    // Copy relevant response headers
    const responseContentType = upstreamResponse.headers.get('Content-Type');
    if (responseContentType) {
      responseHeaders.set('Content-Type', responseContentType);
    }

    // For streaming responses
    const transferEncoding = upstreamResponse.headers.get('Transfer-Encoding');
    if (transferEncoding) {
      responseHeaders.set('Transfer-Encoding', transferEncoding);
    }

    // Disable buffering for streaming
    responseHeaders.set('X-Accel-Buffering', 'no');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    // Log full error server-side for debugging, but don't expose details to clients
    console.error('Relay error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
