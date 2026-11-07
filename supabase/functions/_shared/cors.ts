/**
 * Shared CORS configuration for Edge Functions.
 *
 * Centralizes origin validation for VS Code extensions and web environments.
 */

/**
 * Allowed CORS origins for security. An editor's extension host and the CLI
 * send no Origin header at all; those requests are allowed below. A page on
 * a custom scheme has an opaque origin, which a browser sends as the string
 * "null"; no entry matches it. Codespaces uses *.github.dev domains.
 */
const ALLOWED_ORIGINS: (string | RegExp)[] = [
  // Editor schemes: no browser sends one as an Origin, so these match only a
  // client that sets the header itself.
  'vscode://',
  'vscode-insiders://',
  'cursor://',
  'windsurf://',
  'antigravity://',
  // Codespaces and github.dev
  /^https:\/\/[a-z0-9-]+\.github\.dev$/,
  /^https:\/\/[a-z0-9-]+\.app\.github\.dev$/,
  // TeXRA domains
  /^https:\/\/([a-z0-9-]+\.)?texra\.ai$/,
  // localhost for development
  /^http:\/\/localhost(:\d+)?$/,
];

/**
 * Check if origin is allowed for CORS.
 * @returns The origin if allowed, '*' when the request sent no Origin header
 *   (the extension host, the CLI), null otherwise.
 */
function getAllowedOrigin(origin: string | null): string | null {
  if (!origin) {
    // No Origin header: a non-browser client such as the extension host.
    return '*';
  }

  const isAllowed = ALLOWED_ORIGINS.some((allowed) =>
    typeof allowed === 'string'
      ? origin.startsWith(allowed)
      : allowed.test(origin),
  );

  return isAllowed ? origin : null;
}

/**
 * Get CORS headers for a request.
 */
export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin');
  const allowedOrigin = getAllowedOrigin(origin);

  return {
    'Access-Control-Allow-Origin': allowedOrigin || '',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

/**
 * Handle CORS preflight or reject disallowed origins.
 * @returns Response if handled (preflight or rejected), null if request should proceed.
 */
export function handleCors(req: Request): Response | null {
  const corsHeaders = getCorsHeaders(req);

  // Reject requests from disallowed origins
  if (!corsHeaders['Access-Control-Allow-Origin']) {
    return new Response('Forbidden', { status: 403 });
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  return null;
}
