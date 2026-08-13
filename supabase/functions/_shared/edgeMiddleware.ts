/** Shared Hono middleware for edge functions. */

import type { Context, Next } from '@hono/hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient, anonClient } from './edgeClients.ts';
import { errorResponse } from './responses.ts';

/**
 * Hono context variables set by {@link requireSupabaseClients}. `any` schema
 * so `.schema('auth')` queries typecheck on the service-role client.
 */
export type SupabaseClientVariables = {
  supabase: SupabaseClient<any>;
  authClient: SupabaseClient<any>;
};

/**
 * Require both edge clients before running the route: the service-role
 * client (as `supabase`) and the anon client (as `authClient`). Rejects with
 * a config-error response when either key is missing, otherwise sets both
 * clients on the context for downstream handlers.
 */
export async function requireSupabaseClients(
  c: Context<{ Variables: SupabaseClientVariables }>,
  next: Next,
): Promise<Response | void> {
  if (!adminClient || !anonClient) {
    return errorResponse(c.req.raw, 'Server configuration error', 500);
  }
  c.set('supabase', adminClient);
  c.set('authClient', anonClient);
  await next();
}
