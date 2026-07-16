/** Shared native GoTrue session minting for edge functions. */

import type { Session, SupabaseClient } from '@supabase/supabase-js';

/**
 * Mint a native GoTrue session for an existing user. Generates an admin
 * magic-link token and consumes it immediately server-side, so GoTrue issues a
 * standard session with rotating refresh.
 */
export async function mintGoTrueSession(
  adminClient: SupabaseClient<any>,
  authClient: SupabaseClient<any>,
  email: string,
): Promise<Session | null> {
  // Supabase admin.generateLink returns link/OTP material for custom delivery.
  // Consume the hash immediately server-side; GoTrue mailer behavior depends on
  // the deployment's auth email configuration.
  const { data: linkData, error: linkError } =
    await adminClient.auth.admin.generateLink({ type: 'magiclink', email });

  const tokenHash = linkData?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    console.error(
      '[AUTH] generateLink failed:',
      linkError?.message ?? 'no hashed_token',
    );
    return null;
  }

  const { data, error } = await authClient.auth.verifyOtp({
    type: 'magiclink',
    token_hash: tokenHash,
  });

  if (error || !data.session) {
    console.error('[AUTH] verifyOtp failed:', error?.message);
    return null;
  }

  return data.session;
}

/**
 * Session payload shared by GoTrue-session-minting auth endpoints
 * (auth-github /exchange, /refresh and auth-device /token). Returns a plain
 * object type (not a named interface) so it stays structurally assignable to
 * the `Record<string, unknown>` body param of `versionedJsonResponse`.
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
