/** Shared user-JWT authentication for edge functions. */

import {
  createClient,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';

/** Extract the bearer token from the Authorization header. */
export function bearerToken(req: Request): string | null {
  const authHeader = req.headers.get('Authorization');
  return authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

interface AuthenticatedUser {
  user: User;
  /**
   * User-scoped client (anon key + the user's JWT), so RLS applies to
   * database queries made with it.
   */
  client: SupabaseClient;
}

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');

/**
 * Validate a user JWT and return the user plus a user-scoped client.
 * Returns null when the JWT is missing, invalid, or expired (callers should
 * have already verified SUPABASE_URL / SUPABASE_ANON_KEY to distinguish
 * configuration errors from auth failures).
 */
export async function authenticateJwt(
  jwt: string | null,
): Promise<AuthenticatedUser | null> {
  if (!jwt || !supabaseUrl || !supabaseAnonKey) return null;

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user) return null;

  return { user, client };
}
