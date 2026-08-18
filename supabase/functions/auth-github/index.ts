/**
 * Auth GitHub Edge Function - VS Code GitHub authentication for Supabase.
 *
 * Lets the VS Code extension sign users in with VS Code's built-in GitHub
 * auth (works on desktop, Codespaces, Remote SSH) where standard OAuth
 * callbacks don't work reliably. The extension posts the GitHub token here;
 * this function validates it with GitHub, finds or creates the Supabase
 * user, and returns a NATIVE GoTrue session (minted via an admin magic-link
 * token consumed server-side). Tokens are therefore signed
 * with the project's current JWT signing keys and refresh through GoTrue's
 * standard rotation; there is no hand-rolled JWT or custom session store.
 *
 * Routes:
 * - POST /exchange - Exchange GitHub token for a GoTrue session
 * - POST /refresh  - Refresh a session (GoTrue refresh-token passthrough,
 *                    kept for older extension clients; new clients refresh
 *                    directly via supabase-js)
 *
 * Security:
 * - GitHub token validated with GitHub's API
 * - Service role key for user management; sign-up policy enforced for new users
 */

import { Hono } from '@hono/hono';
import { handleCors } from '../_shared/cors.ts';
import {
  requireSupabaseClients,
  type SupabaseClientVariables,
} from '../_shared/edgeMiddleware.ts';
import {
  checkEmailDomain,
  checkGitHubAccountAge,
} from '../_shared/emailPolicy.ts';
import {
  mintGoTrueSession,
  sessionResponseBody,
} from '../_shared/goTrueSession.ts';
import { errorResponse, jsonResponse } from '../_shared/responses.ts';

// =============================================================================
// Types
// =============================================================================

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  avatar_url: string;
  name: string | null;
  created_at: string;
}

type MetadataRecord = Record<string, unknown>;

// =============================================================================
// Hono App
// =============================================================================

// The edge runtime hands over paths including the function slug
// (/auth-github/exchange).
const app = new Hono<{ Variables: SupabaseClientVariables }>().basePath(
  '/auth-github',
);

// CORS middleware using shared utilities
app.use('*', async (c, next) => {
  const response = handleCors(c.req.raw);
  if (response) return response;
  await next();
});

// Initialize Supabase client
app.use('*', requireSupabaseClients);

// =============================================================================
// Helpers
// =============================================================================

function githubAppMetadata(
  existing: MetadataRecord | null | undefined,
): MetadataRecord {
  const currentProviders = Array.isArray(existing?.providers)
    ? existing.providers.filter(
        (provider): provider is string => typeof provider === 'string',
      )
    : [];
  return {
    ...(existing ?? {}),
    provider: 'github',
    providers: [...new Set([...currentProviders, 'github'])],
  };
}

/**
 * Build the admin `updateUserById` payload that merges the fresh GitHub
 * profile onto an existing user: GitHub fields win in user_metadata, and the
 * github provider is recorded in app_metadata.
 */
function githubProfileUpdate(
  existingUserMetadata: MetadataRecord | null | undefined,
  existingAppMetadata: MetadataRecord | null | undefined,
  githubUserMetadata: MetadataRecord,
): MetadataRecord {
  return {
    user_metadata: { ...(existingUserMetadata ?? {}), ...githubUserMetadata },
    app_metadata: githubAppMetadata(existingAppMetadata),
  };
}

async function validateGitHubToken(
  token: string,
): Promise<{ user: GitHubUser; email: string } | { error: string }> {
  // Try both authorization header formats since VS Code's GitHub auth
  // provider returns different token types depending on the environment.
  // Modern tokens use "Bearer", legacy/OAuth tokens may require "token".
  const authFormats = [`Bearer ${token}`, `token ${token}`];

  let lastError = '';
  let userRes: Response | null = null;
  let workingHeaders: Record<string, string> | null = null;

  for (const authHeader of authFormats) {
    const headers = {
      Authorization: authHeader,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'TeXRA-Auth',
    };

    userRes = await fetch('https://api.github.com/user', { headers });

    if (userRes.ok) {
      workingHeaders = headers;
      break;
    }

    const errorText = await userRes.text().catch(() => 'unknown');
    lastError = `${userRes.status} - ${errorText}`;
    console.warn(
      `[AUTH] GitHub /user API failed with ${
        authHeader.split(' ')[0]
      } auth: ${lastError}`,
    );

    // Only retry with next format if we got 401 (unauthorized)
    if (userRes.status !== 401) {
      break;
    }
  }

  if (!userRes || !userRes.ok || !workingHeaders) {
    console.error(`[AUTH] GitHub token validation failed: ${lastError}`);
    return {
      error: `GitHub API rejected token (${lastError.split(' - ')[0]})`,
    };
  }

  const user: GitHubUser = await userRes.json();
  let primaryEmail = user.email;

  const emailsRes = await fetch('https://api.github.com/user/emails', {
    headers: workingHeaders,
  });
  if (emailsRes.ok) {
    const emails = await emailsRes.json();
    const primary = emails.find(
      (e: { primary: boolean; verified: boolean; email: string }) =>
        e.primary && e.verified,
    );
    if (primary) primaryEmail = primary.email;
  } else {
    console.warn(
      `[AUTH] GitHub /user/emails API failed: ${emailsRes.status}, using profile email`,
    );
  }

  if (!primaryEmail) {
    console.error(
      `[AUTH] No verified email for GitHub user ${user.login} (id: ${user.id})`,
    );
    return { error: 'No verified email on GitHub account' };
  }

  return { user, email: primaryEmail };
}

// =============================================================================
// Routes
// =============================================================================

// POST /exchange - Exchange GitHub token for Supabase session
app.post('/exchange', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body?.github_token) {
      return errorResponse(c.req.raw, 'github_token required', 400);
    }

    const githubResult = await validateGitHubToken(body.github_token);
    if ('error' in githubResult) {
      return errorResponse(c.req.raw, githubResult.error, 401);
    }

    const { user: githubUser, email } = githubResult;
    const githubProviderId = githubUser.id.toString();
    const supabase = c.get('supabase');
    const githubUserMetadata = {
      avatar_url: githubUser.avatar_url,
      user_name: githubUser.login,
      full_name: githubUser.name || githubUser.login,
    };

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
      const { data: userData, error: userError } =
        await supabase.auth.admin.getUserById(userId);
      if (userError || !userData?.user) {
        console.error('[AUTH] Failed to load linked user:', userError?.message);
        return errorResponse(c.req.raw, 'Failed to load linked user', 500);
      }
      const storedEmail = userData.user.email?.trim();
      const identityUpdate: MetadataRecord = githubProfileUpdate(
        userData.user.user_metadata,
        userData.user.app_metadata,
        githubUserMetadata,
      );
      if (storedEmail) {
        userEmail = storedEmail;
      } else {
        identityUpdate.email = email;
        identityUpdate.email_confirm = true;
      }
      const { data: updatedUser, error: updateError } =
        await supabase.auth.admin.updateUserById(userId, identityUpdate);
      if (updateError) {
        console.error(
          '[AUTH] Failed to update linked GitHub user:',
          updateError.message,
        );
        return errorResponse(
          c.req.raw,
          'Failed to update linked GitHub user',
          500,
        );
      }
      if (!storedEmail) {
        const boundEmail = updatedUser?.user?.email?.trim();
        if (!boundEmail) {
          console.error('[AUTH] GitHub email bind produced no stored email');
          return errorResponse(
            c.req.raw,
            'Failed to bind verified GitHub email to linked account',
            500,
          );
        }
        userEmail = boundEmail;
      }
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
        userEmail = authUser.email ?? email;
        const { error: updateError } = await supabase.auth.admin.updateUserById(
          userId,
          githubProfileUpdate(
            authUser.raw_user_meta_data,
            authUser.raw_app_meta_data,
            githubUserMetadata,
          ),
        );
        if (updateError) {
          console.error(
            '[AUTH] Failed to update email-matched GitHub user:',
            updateError.message,
          );
          return errorResponse(c.req.raw, 'Failed to update GitHub user', 500);
        }
      } else {
        // New user — enforce sign-up policy (existing users are never re-checked).
        const emailDecision = checkEmailDomain(email);
        if (!emailDecision.allowed) {
          console.warn(
            `[AUTH] Sign-up rejected for GitHub ${githubUser.login} (${email}): ${emailDecision.reason}`,
          );
          return errorResponse(c.req.raw, emailDecision.userMessage, 403);
        }

        const ageDecision = checkGitHubAccountAge(githubUser.created_at);
        if (!ageDecision.allowed) {
          console.warn(
            `[AUTH] Sign-up rejected for GitHub ${githubUser.login} (${email}): ${ageDecision.reason}`,
          );
          return errorResponse(c.req.raw, ageDecision.userMessage, 403);
        }

        // Create new user
        const { data: newUser, error } = await supabase.auth.admin.createUser({
          email,
          email_confirm: true,
          user_metadata: githubUserMetadata,
          app_metadata: githubAppMetadata(null),
        });

        if (error || !newUser?.user) {
          return errorResponse(c.req.raw, 'Failed to create user', 500);
        }
        userId = newUser.user.id;
        userEmail = newUser.user.email ?? email;
      }

      // Identity linking is best-effort: constraint/duplicate failures are
      // logged and the exchange proceeds, since the session mint below is what
      // actually signs the user in.
      const { error: identityError } = await supabase
        .schema('auth')
        .from('identities')
        .insert({
          id: crypto.randomUUID(),
          user_id: userId,
          provider: 'github',
          provider_id: githubProviderId,
          identity_data: {
            sub: githubProviderId,
            email,
            avatar_url: githubUser.avatar_url,
            user_name: githubUser.login,
          },
          last_sign_in_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      if (identityError) {
        console.warn('[AUTH] Identity link skipped:', identityError.message);
      }
    }

    const session = await mintGoTrueSession(
      supabase,
      c.get('authClient'),
      userEmail,
      userId,
      '[AUTH]',
    );
    if (!session) {
      return errorResponse(c.req.raw, 'Failed to create session', 500);
    }

    console.log(`[AUTH] Exchange successful for user ${userId}`);

    return jsonResponse(c.req.raw, sessionResponseBody(session), 200);
  } catch (error) {
    console.error('[AUTH] Exchange error:', error);
    return errorResponse(c.req.raw, 'Internal server error', 500);
  }
});

// POST /refresh - Refresh an access token (GoTrue passthrough). Pre-3.0
// custom refresh tokens are unknown to GoTrue and get a 401, prompting a
// clean re-sign-in.
app.post('/refresh', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body?.refresh_token) {
      return errorResponse(c.req.raw, 'refresh_token required', 400);
    }

    const { data, error } = await c.get('authClient').auth.refreshSession({
      refresh_token: body.refresh_token,
    });

    if (error || !data.session) {
      return errorResponse(c.req.raw, 'Invalid refresh token', 401);
    }

    console.log(`[AUTH] Refresh successful for user ${data.session.user.id}`);

    return jsonResponse(c.req.raw, sessionResponseBody(data.session), 200);
  } catch (error) {
    console.error('[AUTH] Refresh error:', error);
    return errorResponse(c.req.raw, 'Internal server error', 500);
  }
});

// 404 for other routes
app.all('*', (c) => errorResponse(c.req.raw, 'Not found', 404));

Deno.serve(app.fetch);
