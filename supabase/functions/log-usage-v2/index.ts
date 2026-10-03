/**
 * Log Usage v2 Edge Function - usage batches from current TeXRA clients,
 * anonymous: a random install id (lowercase UUIDv4) in X-TeXRA-Install-Id, no
 * login, no account link.
 *
 * POST /log-usage-v2 - Log a batch of usage entries (shared handling and
 * response contract: `_shared/logUsage.ts`).
 */

import { serveLogUsage } from '../_shared/logUsage.ts';
import { storeForInstall } from './installStore.ts';
import { resolveInstallOwner } from './usageOwner.ts';

serveLogUsage(resolveInstallOwner, storeForInstall);
