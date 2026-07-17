/**
 * Shared helpers for the `unset_api_key` tool.
 *
 * Provider validation and credential-cache refresh remain here so the tool's
 * execution path stays focused on the single delete operation.
 */

import {
  API_PROVIDERS,
  invalidateApiKeyCache,
  isApiProvider,
  type ApiProvider,
} from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { ToolError } from '@shared/schemas/toolResult';

import type { SetupPlatform } from './platform';

/**
 * Trim and validate a provider name, throwing a `ToolError` with the supported
 * list when it isn't a known provider.
 */
export function requireApiProvider(raw: string): ApiProvider {
  const provider = raw.trim();
  if (!isApiProvider(provider)) {
    throw new ToolError(
      `Unknown provider "${provider}". Supported: ${API_PROVIDERS.join(', ')}.`,
    );
  }
  return provider;
}

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
