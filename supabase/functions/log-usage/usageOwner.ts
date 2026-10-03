/** Owner of a `log-usage` batch: the signed-in user of a released client. */

import { authenticateJwt, bearerToken } from '../_shared/auth.ts';
import type { UsageOwner } from '../_shared/logUsage.ts';

/** The bearer token must authenticate; the install header is never read. */
export async function resolveJwtOwner(
  req: Request,
): Promise<UsageOwner | null> {
  const jwt = bearerToken(req);
  const auth = jwt ? await authenticateJwt(jwt) : null;
  return auth ? { userId: auth.user.id, installId: null } : null;
}
