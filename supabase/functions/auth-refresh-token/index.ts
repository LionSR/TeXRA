/**
 * Auth Refresh Token Edge Function - Refresh access tokens for VS Code GitHub auth sessions.
 *
 * This companion function to auth-github-token handles token refresh for sessions
 * created via VS Code's built-in GitHub authentication. Since those sessions use
 * custom refresh tokens stored in our sessions table (not Supabase's internal auth),
 * the standard supabase.auth.refreshSession() won't work.
 *
 * Flow:
 * 1. Client sends refresh_token
 * 2. We look it up in sessions table
 * 3. If valid and not expired, generate new access token
 * 4. Optionally rotate refresh token
 * 5. Return new tokens
 *
 * Authentication: Refresh token in request body
 *
 * Endpoints:
 * - POST /auth-refresh-token - Refresh an access token
 */

import { createClient } from 'jsr:@supabase/supabase-js@2.89.0';
import {
  create,
  getNumericDate,
} from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

// =============================================================================
// Constants
// =============================================================================

const AUTH_REFRESH_VERSION = '1.0.0';

/**
 * Allowed CORS origins for security.
 * Must match auth-github-token for consistency.
 */
const ALLOWED_ORIGINS = [
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

// Session duration: 1 hour access token
const ACCESS_TOKEN_EXPIRY_SECONDS = 3600;

// =============================================================================
// CORS Helpers
// =============================================================================

function getAllowedOrigin(origin: string | null): string | null {
  if (!origin) {
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

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin');
  const allowedOrigin = getAllowedOrigin(origin);

  return {
    'Access-Control-Allow-Origin': allowedOrigin || '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

// =============================================================================
// Response Helpers
// =============================================================================

function jsonResponse(body: Record<string, unknown>, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ _version: AUTH_REFRESH_VERSION, ...body }),
    {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    },
  );
}

function errorResponse(error: string, status: number, corsHeaders: Record<string, string>): Response {
  return jsonResponse({ error }, status, corsHeaders);
}

// =============================================================================
// JWT Creation
// =============================================================================

interface UserData {
  id: string;
  email: string;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
}

async function createAccessToken(
  jwtSecret: string,
  supabaseUrl: string,
  user: UserData,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const encoder = new TextEncoder();
  const keyData = encoder.encode(jwtSecret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );

  return create(
    { alg: 'HS256', typ: 'JWT' },
    {
      iss: `${supabaseUrl}/auth/v1`,
      sub: user.id,
      aud: 'authenticated',
      exp: getNumericDate(ACCESS_TOKEN_EXPIRY_SECONDS),
      iat: getNumericDate(0),
      email: user.email,
      phone: '',
      app_metadata: user.app_metadata,
      user_metadata: user.user_metadata,
      role: 'authenticated',
      aal: 'aal1',
      amr: [{ method: 'oauth', timestamp: now }],
      session_id: crypto.randomUUID(),
      is_anonymous: false,
    },
    key,
  );
}

// =============================================================================
// Environment Validation
// =============================================================================

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const jwtSecret = Deno.env.get('SUPABASE_JWT_SECRET');

if (!supabaseUrl || !supabaseServiceKey || !jwtSecret) {
  console.error('[AUTH_REFRESH] Missing required environment variables');
}

// =============================================================================
// Request Handler
// =============================================================================

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  if (!corsHeaders['Access-Control-Allow-Origin']) {
    return new Response('Forbidden', { status: 403 });
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, corsHeaders);
  }

  if (!supabaseUrl || !supabaseServiceKey || !jwtSecret) {
    return errorResponse('Server configuration error', 500, corsHeaders);
  }

  try {
    // 1. Parse request body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Invalid JSON body', 400, corsHeaders);
    }

    const { refresh_token } = body as { refresh_token?: string };
    if (!refresh_token) {
      return errorResponse('refresh_token required', 400, corsHeaders);
    }

    // 2. Set up Supabase admin client
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 3. Look up session by refresh token
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('id, user_id, not_after')
      .eq('refresh_token', refresh_token)
      .limit(1)
      .single();

    if (sessionError || !session) {
      console.log('[AUTH_REFRESH] Invalid refresh token');
      return errorResponse('Invalid refresh token', 401, corsHeaders);
    }

    // 4. Check if session has expired
    const notAfter = new Date(session.not_after);
    if (notAfter < new Date()) {
      console.log('[AUTH_REFRESH] Refresh token expired');
      // Clean up expired session
      await supabase.from('sessions').delete().eq('id', session.id);
      return errorResponse('Refresh token expired', 401, corsHeaders);
    }

    // 5. Get user data for JWT claims
    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(session.user_id);

    if (userError || !userData?.user) {
      console.error('[AUTH_REFRESH] Failed to get user:', userError?.message);
      return errorResponse('User not found', 401, corsHeaders);
    }

    const user = userData.user;

    // 6. Generate new access token
    const accessToken = await createAccessToken(jwtSecret, supabaseUrl, {
      id: user.id,
      email: user.email || '',
      user_metadata: user.user_metadata || {},
      app_metadata: user.app_metadata || {},
    });

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ACCESS_TOKEN_EXPIRY_SECONDS;

    // 7. Update session last used time
    await supabase
      .from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', session.id);

    console.log(`[AUTH_REFRESH] Refreshed token for user ${user.id}`);

    // 8. Return new access token (keep same refresh token)
    return jsonResponse(
      {
        access_token: accessToken,
        refresh_token: refresh_token, // Return same token - no rotation for simplicity
        expires_at: expiresAt,
        expires_in: ACCESS_TOKEN_EXPIRY_SECONDS,
        token_type: 'bearer',
        user: {
          id: user.id,
          email: user.email,
          user_metadata: {
            avatar_url: user.user_metadata?.avatar_url,
            user_name: user.user_metadata?.user_name,
          },
        },
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    console.error('[AUTH_REFRESH] Unexpected error:', error);
    return errorResponse('Internal server error', 500, corsHeaders);
  }
});
