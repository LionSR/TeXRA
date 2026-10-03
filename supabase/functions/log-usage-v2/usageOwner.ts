/** Owner of a `log-usage-v2` batch: an anonymous install. */

import type { UsageOwner } from '../_shared/logUsage.ts';

export const INSTALL_ID_HEADER = 'X-TeXRA-Install-Id';
const INSTALL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A lowercase UUIDv4 in the install header; any Authorization is ignored. */
export function resolveInstallOwner(req: Request): Promise<UsageOwner | null> {
  const installId = req.headers.get(INSTALL_ID_HEADER)?.toLowerCase();
  return Promise.resolve(
    installId && INSTALL_ID_PATTERN.test(installId)
      ? { userId: null, installId }
      : null,
  );
}
