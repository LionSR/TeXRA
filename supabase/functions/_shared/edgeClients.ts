/** Shared Supabase client construction for edge functions. */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Stateless server client (no token refresh, no persisted session). */
export function createEdgeClient(
  url: string | undefined,
  key: string | undefined,
): SupabaseClient<any> | null {
  if (!url || !key) return null;
  return createClient<any>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
