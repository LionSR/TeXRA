/**
 * Shared Supabase environment and stateless edge clients, read once at load.
 *
 * The hosted runtime sets all three keys for every function, so a missing
 * one is a misconfigured deploy: the import throws and the worker does not
 * start, and no request has to ask again.
 */

import { createClient } from '@supabase/supabase-js';

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const SUPABASE_URL = requireEnv('SUPABASE_URL');
export const SUPABASE_ANON_KEY = requireEnv('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

/** Stateless server clients: no token refresh, no persisted session. */
const STATELESS = { auth: { autoRefreshToken: false, persistSession: false } };

/** Service-role client: bypasses RLS, never reachable from a browser. */
export const adminClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  STATELESS,
);

/** Anon-key client used to consume server-minted GoTrue tokens. */
export const anonClient = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  STATELESS,
);
