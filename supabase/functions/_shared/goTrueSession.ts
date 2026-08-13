/** Shared native GoTrue session minting for edge functions. */

import type { Session, SupabaseClient } from '@supabase/supabase-js';

/**
 * Mint a native GoTrue session for an existing user. Generates an admin
 * magic-link token and consumes it immediately server-side, so GoTrue issues a
 * standard session with rotating refresh.
 *
 * The minted session must belong to `expectedUserId` — the user the caller
 * already resolved from its own identity lookup. A mismatch means the email
 * resolved to a different account, so the session is refused rather than
 * handed back.
 */
export async function mintGoTrueSession(
  adminClient: SupabaseClient<any>,
  authClient: SupabaseClient<any>,
  email: string,
  expectedUserId: string,
  // Log tag of the calling flow, so a mismatch stays greppable per flow.
  logPrefix: string,
): Promise<Session | null> {
  // Supabase admin.generateLink returns link/OTP material for custom delivery.
  // Consume the hash immediately server-side; GoTrue mailer behavior depends on
  // the deployment's auth email configuration.
  const { data: linkData, error: linkError } =
    await adminClient.auth.admin.generateLink({ type: 'magiclink', email });

  const tokenHash = linkData?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    console.error(
      `${logPrefix} generateLink failed:`,
      linkError?.message ?? 'no hashed_token',
    );
    return null;
  }

  const { data, error } = await authClient.auth.verifyOtp({
    type: 'magiclink',
    token_hash: tokenHash,
  });

  if (error || !data.session) {
    console.error(`${logPrefix} verifyOtp failed:`, error?.message);
    return null;
  }
  if (data.session.user.id !== expectedUserId) {
    console.error(
      `${logPrefix} session user mismatch: resolved ${expectedUserId}, minted ${data.session.user.id}`,
    );
    return null;
  }

  return data.session;
}

/**
 * Session payload shared by GoTrue-session-minting auth endpoints
 * (auth-github /exchange, /refresh and auth-device /token). Returns a plain
 * object type (not a named interface) so it stays structurally assignable to
 * the `Record<string, unknown>` body parameter of `jsonResponse`.
 */
export function sessionResponseBody(session: Session) {
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in,
    token_type: session.token_type,
    user: {
      id: session.user.id,
      email: session.user.email,
      user_metadata: {
        avatar_url: session.user.user_metadata?.avatar_url,
        user_name: session.user.user_metadata?.user_name,
      },
    },
  };
}
