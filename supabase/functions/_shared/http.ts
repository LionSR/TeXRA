/**
 * Shared HTTP helpers for edge functions: the bearer token a request carries
 * and the JSON responses they answer with. No Supabase import, so a function
 * that never talks to Supabase can use it.
 */

import { getCorsHeaders } from './cors.ts';

/** The bearer token in the Authorization header, or null. */
export function bearerToken(req: Request): string | null {
  const authHeader = req.headers.get('Authorization');
  return authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

/** JSON response carrying CORS headers. */
export function jsonResponse(
  req: Request,
  body: Record<string, unknown>,
  status: number,
): Response {
  return Response.json(body, { status, headers: getCorsHeaders(req) });
}

/** JSON `{ error }` response, the failure shape shared by the auth functions. */
export function errorResponse(
  req: Request,
  error: string,
  status: number,
): Response {
  return jsonResponse(req, { error }, status);
}
