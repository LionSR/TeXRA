/**
 * Shared Supabase environment and stateless edge clients.
 *
 * Env and clients are fixed at cold start, so every function reads the same
 * values and builds its clients the same way. A client is null when the key it
 * needs is missing; callers must reject the request explicitly rather than
 * dereference it.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
export const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

/** Stateless server client (no token refresh, no persisted session). */
function createEdgeClient(
  url: string | undefined,
  key: string | undefined,
): SupabaseClient | null {
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Service-role client: bypasses RLS, never reachable from a browser. */
export const adminClient = createEdgeClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
);

/** Anon-key client used to consume server-minted GoTrue tokens. */
export const anonClient = createEdgeClient(SUPABASE_URL, SUPABASE_ANON_KEY);
