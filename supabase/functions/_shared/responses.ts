/** Shared JSON response helper for edge functions. */

import { getCorsHeaders } from './cors.ts';

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
