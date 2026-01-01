/**
 * Auth GitHub Edge Function - VS Code GitHub authentication for Supabase.
 *
 * Provides authentication for VS Code web/Codespaces where standard OAuth
 * callbacks don't work reliably. Uses VS Code's built-in GitHub auth.
 *
 * Routes:
 * - POST /exchange - Exchange GitHub token for Supabase session
 * - POST /refresh  - Refresh an access token
 *
 * Security:
 * - GitHub token validated with GitHub's API
 * - Service role key for user management
 * - JWTs signed with Supabase's JWT secret
 */

import { Hono } from 'jsr:@hono/hono@4';
import { cors } from 'jsr:@hono/hono@4/cors';
import { createClient } from 'jsr:@supabase/supabase-js@2.89.0';
import { create, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { ALLOWED_ORIGINS } from '../_shared/cors.ts';

// =============================================================================
// Constants
// =============================================================================

const VERSION = '2.0.0';
const ACCESS_TOKEN_EXPIRY_SECONDS = 3600;
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

// =============================================================================
// Environment
// =============================================================================

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const jwtSecret = Deno.env.get('SUPABASE_JWT_SECRET')!;

// =============================================================================
// Types
// =============================================================================

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  avatar_url: string;
  name: string | null;
}

type Variables = {
  supabase: ReturnType<typeof createClient>;
  corsHeaders: Record<string, string>;
};

// =============================================================================
// Hono App
// =============================================================================

const app = new Hono<{ Variables: Variables }>();

// Custom CORS middleware for VS Code origins
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');

  // Check if origin is allowed
  let allowedOrigin: string | null = null;
  if (!origin) {
    allowedOrigin = '*'; // VS Code opaque origins
  } else {
    for (const allowed of ALLOWED_ORIGINS) {
      if (typeof allowed === 'string' && origin.startsWith(allowed)) {
        allowedOrigin = origin;
        break;
      } else if (allowed instanceof RegExp && allowed.test(origin)) {
        allowedOrigin = origin;
        break;
      }
    }
  }

  if (!allowedOrigin) {
    return c.text('Forbidden', 403);
  }

  // Set CORS headers
  c.set('corsHeaders', {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  });

  // Handle preflight
  if (c.req.method === 'OPTIONS') {
    return new Response('ok', { headers: c.get('corsHeaders') });
  }

  await next();
});

// Initialize Supabase client
app.use('*', async (c, next) => {
  if (!supabaseUrl || !supabaseServiceKey || !jwtSecret) {
    return c.json({ error: 'Server configuration error', _version: VERSION }, 500);
  }

  c.set('supabase', createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  }));

  await next();
});

// =============================================================================
// Helpers
// =============================================================================

function jsonResponse(c: Parameters<Parameters<typeof app.post>[1]>[0], body: Record<string, unknown>, status: number) {
  return c.json({ _version: VERSION, ...body }, status, c.get('corsHeaders'));
}

async function validateGitHubToken(token: string): Promise<{ user: GitHubUser; email: string } | null> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'TeXRA-Auth',
  };

  const userRes = await fetch('https://api.github.com/user', { headers });
  if (!userRes.ok) return null;

  const user: GitHubUser = await userRes.json();
  let primaryEmail = user.email;

  const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
  if (emailsRes.ok) {
    const emails = await emailsRes.json();
    const primary = emails.find((e: { primary: boolean; verified: boolean; email: string }) => e.primary && e.verified);
    if (primary) primaryEmail = primary.email;
  }

  if (!primaryEmail) return null;
  return { user, email: primaryEmail };
}

async function createJWT(
  userId: string,
  email: string,
  userMetadata: Record<string, unknown>,
  appMetadata: Record<string, unknown>,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(jwtSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );

  return create(
    { alg: 'HS256', typ: 'JWT' },
    {
      iss: `${supabaseUrl}/auth/v1`,
      sub: userId,
      aud: 'authenticated',
      exp: getNumericDate(ACCESS_TOKEN_EXPIRY_SECONDS),
      iat: getNumericDate(0),
      email,
      phone: '',
      app_metadata: appMetadata,
      user_metadata: userMetadata,
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
// Routes
// =============================================================================

// POST /exchange - Exchange GitHub token for Supabase session
app.post('/exchange', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body?.github_token) {
      return jsonResponse(c, { error: 'github_token required' }, 400);
    }

    const githubData = await validateGitHubToken(body.github_token);
    if (!githubData) {
      return jsonResponse(c, { error: 'Invalid GitHub token or missing verified email' }, 401);
    }

    const { user: githubUser, email } = githubData;
    const githubProviderId = githubUser.id.toString();
    const supabase = c.get('supabase');

    console.log(`[AUTH] Exchange for GitHub user ${githubUser.login}`);

    // Find existing user by GitHub identity
    const { data: identities } = await supabase
      .schema('auth')
      .from('identities')
      .select('user_id')
      .eq('provider', 'github')
      .eq('provider_id', githubProviderId)
      .limit(1);

    let userId: string;
    let userEmail = email;

    if (identities?.length) {
      userId = identities[0].user_id;
      const { data: userData } = await supabase.auth.admin.getUserById(userId);
      userEmail = userData?.user?.email || email;
    } else {
      // Check by email
      const { data: authUser } = await supabase
        .schema('auth')
        .from('users')
        .select('id, email, raw_user_meta_data, raw_app_meta_data')
        .eq('email', email)
        .maybeSingle();

      if (authUser) {
        userId = authUser.id;
        await supabase.auth.admin.updateUserById(userId, {
          user_metadata: {
            ...authUser.raw_user_meta_data,
            avatar_url: githubUser.avatar_url,
            user_name: githubUser.login,
          },
        });
      } else {
        // Create new user
        const { data: newUser, error } = await supabase.auth.admin.createUser({
          email,
          email_confirm: true,
          user_metadata: {
            avatar_url: githubUser.avatar_url,
            user_name: githubUser.login,
            full_name: githubUser.name || githubUser.login,
          },
          app_metadata: { provider: 'github', providers: ['github'] },
        });

        if (error || !newUser?.user) {
          return jsonResponse(c, { error: 'Failed to create user' }, 500);
        }
        userId = newUser.user.id;
      }

      // Link identity
      await supabase.schema('auth').from('identities').insert({
        id: crypto.randomUUID(),
        user_id: userId,
        provider: 'github',
        provider_id: githubProviderId,
        identity_data: { sub: githubProviderId, email, avatar_url: githubUser.avatar_url, user_name: githubUser.login },
        last_sign_in_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).catch(() => {}); // Ignore duplicate
    }

    // Generate tokens
    const accessToken = await createJWT(
      userId,
      userEmail,
      { avatar_url: githubUser.avatar_url, user_name: githubUser.login, email: userEmail, email_verified: true },
      { provider: 'github', providers: ['github'] },
    );

    const refreshToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ACCESS_TOKEN_EXPIRY_SECONDS;

    // Store session
    const { error: sessionError } = await supabase.from('sessions').insert({
      id: crypto.randomUUID(),
      user_id: userId,
      refresh_token: refreshToken,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      not_after: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    });

    if (sessionError) {
      console.error('[AUTH] Session storage failed:', sessionError.message);
      return jsonResponse(c, { error: 'Failed to create session' }, 500);
    }

    console.log(`[AUTH] Exchange successful for user ${userId}`);

    return jsonResponse(c, {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      expires_in: ACCESS_TOKEN_EXPIRY_SECONDS,
      token_type: 'bearer',
      user: { id: userId, email: userEmail, user_metadata: { avatar_url: githubUser.avatar_url, user_name: githubUser.login } },
    }, 200);
  } catch (error) {
    console.error('[AUTH] Exchange error:', error);
    return jsonResponse(c, { error: 'Internal server error' }, 500);
  }
});

// POST /refresh - Refresh an access token
app.post('/refresh', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body?.refresh_token) {
      return jsonResponse(c, { error: 'refresh_token required' }, 400);
    }

    const supabase = c.get('supabase');

    // Look up session
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('id, user_id, not_after')
      .eq('refresh_token', body.refresh_token)
      .limit(1)
      .single();

    if (sessionError || !session) {
      return jsonResponse(c, { error: 'Invalid refresh token' }, 401);
    }

    // Check expiry
    if (new Date(session.not_after) < new Date()) {
      await supabase.from('sessions').delete().eq('id', session.id);
      return jsonResponse(c, { error: 'Refresh token expired' }, 401);
    }

    // Get user
    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(session.user_id);
    if (userError || !userData?.user) {
      return jsonResponse(c, { error: 'User not found' }, 401);
    }

    const user = userData.user;
    const accessToken = await createJWT(
      user.id,
      user.email || '',
      user.user_metadata || {},
      user.app_metadata || {},
    );

    const now = Math.floor(Date.now() / 1000);
    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session.id);

    console.log(`[AUTH] Refresh successful for user ${user.id}`);

    return jsonResponse(c, {
      access_token: accessToken,
      refresh_token: body.refresh_token,
      expires_at: now + ACCESS_TOKEN_EXPIRY_SECONDS,
      expires_in: ACCESS_TOKEN_EXPIRY_SECONDS,
      token_type: 'bearer',
      user: { id: user.id, email: user.email, user_metadata: { avatar_url: user.user_metadata?.avatar_url, user_name: user.user_metadata?.user_name } },
    }, 200);
  } catch (error) {
    console.error('[AUTH] Refresh error:', error);
    return jsonResponse(c, { error: 'Internal server error' }, 500);
  }
});

// 404 for other routes
app.all('*', (c) => jsonResponse(c, { error: 'Not found' }, 404));

Deno.serve(app.fetch);
