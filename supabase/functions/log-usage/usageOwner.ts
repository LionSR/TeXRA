/** Owner of a `log-usage` batch: the signed-in user of a released client. */

import { authenticateJwt, bearerToken } from '../_shared/auth.ts';

/** The bearer token must authenticate; the install header is never read. */
export async function resolveJwtOwner(req: Request): Promise<string | null> {
  const jwt = bearerToken(req);
  const auth = jwt ? await authenticateJwt(jwt) : null;
  return auth?.user.id ?? null;
}
