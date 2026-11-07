/**
 * Log Usage Edge Function (legacy) - usage batches from released clients that
 * send a login JWT (Authorization: Bearer {jwt}). Current clients use
 * `log-usage-v2`; this function is deleted when old releases are retired.
 *
 * POST /log-usage - Log a batch of usage entries (shared handling and
 * response contract: `_shared/logUsage.ts`).
 */

import { logUsageHandler } from '../_shared/logUsage.ts';
import { storeForUser } from './legacyStore.ts';
import { resolveJwtOwner } from './usageOwner.ts';
import { UsageBatchSchema } from './usageValidation.ts';

export const handleRequest = logUsageHandler(
  UsageBatchSchema,
  resolveJwtOwner,
  storeForUser,
);

if (import.meta.main) Deno.serve(handleRequest);
