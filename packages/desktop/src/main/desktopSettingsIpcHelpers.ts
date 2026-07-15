import type { ToolDashboardItem } from '@shared/schemas/settingsViewMessages';
import type { ExternalToolCheckResult } from '@tools/toolAvailability';
import type { PlatformSecrets } from '@platform/secrets';

/**
 * Module-level helpers for the desktop settings IPC. These have no closure
 * dependencies on the IPC instance, so they live here to keep the factory in
 * `desktopSettingsIpc.ts` focused on request wiring. Each tool-availability
 * helper defers its `@tools` import so the heavy module only loads when a tool
 * dashboard request actually arrives.
 */

export const emptySecrets: PlatformSecrets = {
  get: () => Promise.resolve(undefined),
  getStored: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  listStoredKeys: () => Promise.resolve([]),
  getEnv: () => undefined,
};

export function defaultOnError(error: unknown): void {
  console.error(error);
}

export async function buildDefaultToolDashboardItems(
  cachedResults?: ExternalToolCheckResult[],
): Promise<ToolDashboardItem[]> {
  const { buildToolDashboardItems } =
    await import('@controllers/settingsView/ToolDashboardData');
  return buildToolDashboardItems(cachedResults);
}

export async function getCachedToolCheckResults(): Promise<
  ExternalToolCheckResult[] | undefined
> {
  const { getLastCheckResults } = await import('@tools/toolAvailability');
  return getLastCheckResults() ?? undefined;
}

export async function refreshDefaultDisabledToolCache(): Promise<void> {
  const { refreshDisabledToolCache } = await import('@tools/toolAvailability');
  refreshDisabledToolCache();
}

export async function refreshDefaultToolAvailability(): Promise<void> {
  const { refreshToolAvailability } = await import('@tools/toolAvailability');
  await refreshToolAvailability();
}

export async function findToolCommand(
  toolId: string,
  kind: 'install' | 'auth',
): Promise<string | undefined> {
  const { findExternalToolDef } = await import('@tools/externalToolDefs');
  const def = findExternalToolDef(toolId);
  return kind === 'install' ? def?.installCommand : def?.authCommand;
}
