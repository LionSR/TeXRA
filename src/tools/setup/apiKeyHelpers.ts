/**
 * Credential-cache refresh shared by the `unset_api_key` tool and the
 * extension's manual API-key commands.
 */

import { invalidateApiKeyCache } from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';

import type { SetupPlatform } from './platform';

/**
 * Drop cached model availability and key-origin lookups, then refresh the
 * status surfaces. Mirrors the manual `texra.setApiKey` command ordering so
 * every downstream status surface sees the mutation.
 */
export async function refreshApiKeyCaches(
  platform: SetupPlatform,
): Promise<void> {
  invalidateModelOptionsCache();
  invalidateApiKeyCache();
  const commands = platform.commands;
  if (!commands) return;
  // Credential changes must remain successful when a host cannot refresh its
  // status surfaces; the next ordinary refresh will reconcile stale UI.
  await Promise.allSettled([
    commands.invoke('texra.refreshApiKeyStatus'),
    commands.invoke('texra.refreshAllOptions'),
  ]);
}
