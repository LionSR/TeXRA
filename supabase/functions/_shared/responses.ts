/** Shared JSON response helper for edge functions. */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getCorsHeaders } from './cors.ts';

/** Cryptographically random URL-safe base64 string from `byteCount` bytes. */
export function randomBase64Url(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

/** Stateless server client (no token refresh, no persisted session). */
export function createEdgeClient(
  url: string | undefined,
  key: string | undefined,
): SupabaseClient | null {
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** JSON response carrying CORS headers and the function's `_version` stamp. */
export function versionedJsonResponse(
  req: Request,
  version: string,
  body: Record<string, unknown>,
  status: number,
): Response {
  return new Response(JSON.stringify({ _version: version, ...body }), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}
