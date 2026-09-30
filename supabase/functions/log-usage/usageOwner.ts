/** Who a usage batch belongs to: a signed-in user or an anonymous install. */

import { authenticateJwt, bearerToken } from '../_shared/auth.ts';

/** Install-scoped identity for clients without an account (TeXRA >= 1.0). */
export const INSTALL_ID_HEADER = 'X-TeXRA-Install-Id';
const INSTALL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Exactly one owner per row: a GoTrue user (released clients) or an install. */
export type UsageOwner =
  | { readonly userId: string; readonly installId: null }
  | { readonly userId: null; readonly installId: string };

/**
 * A bearer token, when present, must authenticate: an invalid JWT never falls
 * back to the install header. Returns null for a missing or malformed
 * credential.
 */
export async function resolveOwner(req: Request): Promise<UsageOwner | null> {
  const jwt = bearerToken(req);
  if (jwt) {
    const auth = await authenticateJwt(jwt);
    return auth ? { userId: auth.user.id, installId: null } : null;
  }
  const installId = req.headers.get(INSTALL_ID_HEADER)?.toLowerCase();
  return installId && INSTALL_ID_PATTERN.test(installId)
    ? { userId: null, installId }
    : null;
}
