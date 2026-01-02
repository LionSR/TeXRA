/**
 * Shared CORS configuration for Edge Functions.
 *
 * Centralizes origin validation for VS Code extensions and web environments.
 */

/**
 * Allowed CORS origins for security.
 * VS Code extensions use opaque origins (sent as null).
 * Codespaces uses *.github.dev domains.
 */
export const ALLOWED_ORIGINS: (string | RegExp)[] = [
  // VS Code and forks (opaque origins, sent as null in most browsers)
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
 * @returns The origin if allowed, '*' for null origins (VS Code), null otherwise.
 */
export function getAllowedOrigin(origin: string | null): string | null {
  if (!origin) {
    // Null origin (from opaque origins like vscode://) - allow for VS Code extensions
    return '*';
  }

  for (const allowed of ALLOWED_ORIGINS) {
    if (typeof allowed === 'string') {
      if (origin.startsWith(allowed)) {
        return origin;
      }
    } else if (allowed.test(origin)) {
      return origin;
    }
  }

  return null;
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
export function handleCors(req: Request): {
  corsHeaders: Record<string, string>;
  response?: Response;
} {
  const corsHeaders = getCorsHeaders(req);

  // Reject requests from disallowed origins
  if (!corsHeaders['Access-Control-Allow-Origin']) {
    return {
      corsHeaders,
      response: new Response('Forbidden', { status: 403 }),
    };
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return {
      corsHeaders,
      response: new Response('ok', { headers: corsHeaders }),
    };
  }

  return { corsHeaders };
}
