/** Shared user-JWT authentication for edge functions. */

import {
  createClient,
  isAuthApiError,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './edgeClients.ts';

interface AuthenticatedUser {
  user: User;
  /**
   * User-scoped client (anon key + the user's JWT), so RLS applies to
   * database queries made with it.
   */
  client: SupabaseClient;
}

/** GoTrue could not say whether a token is valid: an outage, not a sign-out. */
export class AuthUnavailable extends Error {}

/**
 * Validate a user JWT and return the user plus a user-scoped client, or null
 * when the request is not signed in: no token, or GoTrue refused it (a 4xx
 * answer other than a rate limit). Throws {@link AuthUnavailable} when GoTrue
 * could not answer, which the handler answers with 503.
 */
export async function authenticateJwt(
  jwt: string | null,
): Promise<AuthenticatedUser | null> {
  if (!jwt) return null;

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await client.auth.getUser(jwt);
  if (error) {
    const refused =
      isAuthApiError(error) &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 429;
    if (refused) return null;
    throw new AuthUnavailable(
      `GoTrue could not check the token: ${error.message}`,
      {
        cause: error,
      },
    );
  }

  return { user: data.user, client };
}
