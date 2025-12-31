/**
 * Auth GitHub Token Edge Function - Exchange VS Code GitHub token for Supabase session.
 *
 * This enables authentication in VS Code web/Codespaces where the standard
 * OAuth callback flow doesn't work reliably. Instead:
 * 1. VS Code's built-in GitHub auth provides a GitHub token
 * 2. This function validates it and returns a Supabase session
 * 3. The user gets the same Supabase account as if they used Supabase OAuth
 *
 * The function finds or creates the user based on their GitHub ID, ensuring
 * the same account is used whether logging in via desktop (Supabase OAuth)
 * or Codespaces (VS Code GitHub auth).
 *
 * Authentication: GitHub access token in request body
 *
 * Endpoints:
 * - POST /auth-github-token - Exchange GitHub token for Supabase session
 *
 * Security:
 * - GitHub token is validated with GitHub's API before any Supabase operations
 * - Uses service role key to manage users and generate sessions
 * - JWTs are signed with Supabase's JWT secret
 */

import { createClient } from 'jsr:@supabase/supabase-js@2.89.0';
import {
  create,
  getNumericDate,
} from 'https://deno.land/x/djwt@v3.0.1/mod.ts';

// =============================================================================
// Constants
// =============================================================================

const AUTH_GITHUB_VERSION = '1.0.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Session duration: 1 hour access token, 7 day refresh token
const ACCESS_TOKEN_EXPIRY_SECONDS = 3600;
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

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

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(
    JSON.stringify({ _version: AUTH_GITHUB_VERSION, ...body }),
    {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    },
  );
}

function errorResponse(error: string, status: number): Response {
  return jsonResponse({ error }, status);
}

/**
 * Validate GitHub token and get user info.
 */
async function validateGitHubToken(
  token: string,
): Promise<{ user: GitHubUser; email: string } | null> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'TeXRA-Auth',
  };

  // Get user info
  const userRes = await fetch('https://api.github.com/user', { headers });
  if (!userRes.ok) {
    return null;
  }

  const user: GitHubUser = await userRes.json();

  // Get user's primary verified email
  let primaryEmail = user.email;

  const emailsRes = await fetch('https://api.github.com/user/emails', {
    headers,
  });
  if (emailsRes.ok) {
    const emails: GitHubEmail[] = await emailsRes.json();
    const primary = emails.find((e) => e.primary && e.verified);
    if (primary) {
      primaryEmail = primary.email;
    }
  }

  if (!primaryEmail) {
    return null;
  }

  return { user, email: primaryEmail };
}

/**
 * Create a signed JWT for the user.
 */
async function createAccessToken(
  jwtSecret: string,
  supabaseUrl: string,
  userId: string,
  email: string,
  githubUser: GitHubUser,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const githubProviderId = githubUser.id.toString();

  // Create HMAC key for signing
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
      sub: userId,
      aud: 'authenticated',
      exp: getNumericDate(ACCESS_TOKEN_EXPIRY_SECONDS),
      iat: getNumericDate(0),
      email,
      phone: '',
      app_metadata: {
        provider: 'github',
        providers: ['github'],
      },
      user_metadata: {
        avatar_url: githubUser.avatar_url,
        email,
        email_verified: true,
        full_name: githubUser.name || githubUser.login,
        iss: 'https://api.github.com',
        preferred_username: githubUser.login,
        provider_id: githubProviderId,
        sub: githubProviderId,
        user_name: githubUser.login,
      },
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
// Environment Validation (fail fast)
// =============================================================================

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const jwtSecret = Deno.env.get('SUPABASE_JWT_SECRET');

if (!supabaseUrl || !supabaseServiceKey || !jwtSecret) {
  console.error('[AUTH_GITHUB] Missing required environment variables');
}

// =============================================================================
// Request Handler
// =============================================================================

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  // Check environment on each request
  if (!supabaseUrl || !supabaseServiceKey || !jwtSecret) {
    return errorResponse('Server configuration error', 500);
  }

  try {
    // 1. Parse request body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    const { github_token } = body as { github_token?: string };
    if (!github_token) {
      return errorResponse('github_token required', 400);
    }

    // 2. Validate GitHub token and get user info
    const githubData = await validateGitHubToken(github_token);
    if (!githubData) {
      return errorResponse(
        'Invalid GitHub token or missing verified email',
        401,
      );
    }

    const { user: githubUser, email } = githubData;
    const githubProviderId = githubUser.id.toString();

    console.log(
      `[AUTH_GITHUB] Processing auth for GitHub user ${githubUser.login} (${githubProviderId})`,
    );

    // 3. Set up Supabase admin client
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 4. Find existing user with this GitHub identity
    // Query the auth.identities table (Supabase's internal identity linking)
    const { data: identities } = await supabase
      .from('identities')
      .select('user_id')
      .eq('provider', 'github')
      .eq('provider_id', githubProviderId)
      .limit(1);

    let userId: string;
    let userEmail: string = email;

    if (identities && identities.length > 0) {
      // User exists with this GitHub identity
      userId = identities[0].user_id;
      console.log(`[AUTH_GITHUB] Found existing user: ${userId}`);

      // Get their current email
      const { data: userData } = await supabase.auth.admin.getUserById(userId);
      if (userData?.user?.email) {
        userEmail = userData.user.email;
      }
    } else {
      // Check if user exists with this email (might have signed up differently)
      const { data: existingUsers } = await supabase.auth.admin.listUsers();
      const existingUser = existingUsers?.users?.find(
        (u) => u.email === email,
      );

      if (existingUser) {
        // Link GitHub identity to existing user
        userId = existingUser.id;
        console.log(`[AUTH_GITHUB] Linking GitHub to existing user: ${userId}`);

        // Update user metadata to include GitHub info
        await supabase.auth.admin.updateUserById(userId, {
          user_metadata: {
            ...existingUser.user_metadata,
            avatar_url: githubUser.avatar_url,
            user_name: githubUser.login,
            full_name: githubUser.name || githubUser.login,
            provider_id: githubProviderId,
          },
          app_metadata: {
            ...existingUser.app_metadata,
            provider: 'github',
            providers: [
              ...new Set([
                ...(existingUser.app_metadata?.providers || []),
                'github',
              ]),
            ],
          },
        });
      } else {
        // Create new user with GitHub identity
        console.log(`[AUTH_GITHUB] Creating new user for ${email}`);

        const { data: newUser, error: createError } =
          await supabase.auth.admin.createUser({
            email,
            email_confirm: true,
            user_metadata: {
              avatar_url: githubUser.avatar_url,
              email,
              email_verified: true,
              full_name: githubUser.name || githubUser.login,
              iss: 'https://api.github.com',
              preferred_username: githubUser.login,
              provider_id: githubProviderId,
              sub: githubProviderId,
              user_name: githubUser.login,
            },
            app_metadata: {
              provider: 'github',
              providers: ['github'],
            },
          });

        if (createError || !newUser.user) {
          console.error('[AUTH_GITHUB] Failed to create user:', createError);
          return errorResponse('Failed to create user account', 500);
        }

        userId = newUser.user.id;
      }

      // Insert GitHub identity record for future lookups
      const { error: identityError } = await supabase.from('identities').insert({
        id: crypto.randomUUID(),
        user_id: userId,
        provider: 'github',
        provider_id: githubProviderId,
        identity_data: {
          sub: githubProviderId,
          email,
          avatar_url: githubUser.avatar_url,
          user_name: githubUser.login,
          full_name: githubUser.name || githubUser.login,
        },
        last_sign_in_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      if (identityError) {
        // Non-fatal: user exists but identity linking failed
        // Could be a race condition with another request
        console.warn(
          '[AUTH_GITHUB] Failed to insert identity (may be duplicate):',
          identityError.message,
        );
      }
    }

    // 5. Generate JWT tokens for this user
    const accessToken = await createAccessToken(
      jwtSecret,
      supabaseUrl,
      userId,
      userEmail,
      githubUser,
    );

    // Generate refresh token (random string)
    const refreshToken =
      crypto.randomUUID().replace(/-/g, '') +
      crypto.randomUUID().replace(/-/g, '');

    // Calculate expiry timestamps
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ACCESS_TOKEN_EXPIRY_SECONDS;
    const refreshExpiresAt = new Date(
      Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );

    // Store refresh token in sessions table
    const sessionId = crypto.randomUUID();
    const { error: sessionError } = await supabase.from('sessions').insert({
      id: sessionId,
      user_id: userId,
      refresh_token: refreshToken,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      not_after: refreshExpiresAt.toISOString(),
    });

    if (sessionError) {
      // Non-fatal: session storage failed but access token still works
      console.warn(
        '[AUTH_GITHUB] Failed to store session:',
        sessionError.message,
      );
    }

    // 6. Return session tokens
    console.log(`[AUTH_GITHUB] Auth successful for user ${userId}`);

    return jsonResponse(
      {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        expires_in: ACCESS_TOKEN_EXPIRY_SECONDS,
        token_type: 'bearer',
        user: {
          id: userId,
          email: userEmail,
          user_metadata: {
            avatar_url: githubUser.avatar_url,
            user_name: githubUser.login,
          },
        },
      },
      200,
    );
  } catch (error) {
    console.error('[AUTH_GITHUB] Unexpected error:', error);
    return errorResponse('Internal server error', 500);
  }
});
