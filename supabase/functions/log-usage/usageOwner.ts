/** Owner of a `log-usage` batch: the signed-in user of a released client. */

import { authenticateJwt, bearerToken } from '../_shared/auth.ts';

/** The bearer token must authenticate; the install header is never read. */
export async function resolveJwtOwner(req: Request): Promise<string | null> {
  const auth = await authenticateJwt(bearerToken(req));
  return auth?.user.id ?? null;
}
