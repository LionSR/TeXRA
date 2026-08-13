/** Shared JSON response helpers for edge functions. */

import { getCorsHeaders } from './cors.ts';

/** JSON response carrying CORS headers. */
export function jsonResponse(
  req: Request,
  body: Record<string, unknown>,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}

/** JSON `{ error }` response, the failure shape shared by the auth functions. */
export function errorResponse(
  req: Request,
  error: string,
  status: number,
): Response {
  return jsonResponse(req, { error }, status);
}
