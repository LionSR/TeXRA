// Local imports
import type { ConfigProvider } from '@platform/interfaces';
import { tryWorkspaceRoots, workspaceRoots } from '@platform/workspaceRoots';

/**
 * {@link readConfig} over the calling context's roots, for the callers that
 * hold no workspace of their own: the replacement engine's policy default
 * (reached from a `LaTeXdiffService` constructed without roots) and the
 * process-level Zotero availability probe. Every caller that holds its
 * workspace — a tool call's `roots`, a run's session, a host command's
 * session — reads through {@link readConfig} instead, so this ambient read
 * shrinks as those two get an owner rather than growing new callers.
 *
 * Path conventions:
 * - Use dot notation with or without the canonical `texra.` prefix.
 * - Host settings such as `latex-workshop.*` must use the host adapter rather
 *   than this shared configuration path.
 *
 * A cataloged `texra.*` key resolves its own schema default inside the
 * provider (`ConfigProvider.get`'s documented resolution order), so
 * `defaultValue` is for keys the catalog does not own. A key whose value has a
 * constrained shape (enum, bounded number, structured record) belongs on the
 * catalog and reads through `readPlatformSetting`/`readSettingFrom`, which
 * validate it against the row's schema.
 *
 * @param path Configuration path (e.g., 'agents' or 'api.engine')
 * @param defaultValue Optional fallback for keys the catalog does not own
 * @returns The configured, catalog-default, or caller-fallback value
 */
export function getConfig<T>(path: string, defaultValue?: T): T {
  return readConfig(workspaceRoots().config, path, defaultValue);
}

/**
 * {@link getConfig} over an explicit provider: the configuration of the
 * workspace the caller was handed (a tool call's `roots.config`), resolved by
 * that provider's own documented order — configured value, catalog default,
 * then the caller's fallback.
 */
export function readConfig<T>(
  config: ConfigProvider,
  path: string,
  defaultValue?: T,
): T {
  return config.get<T>(path, defaultValue as T);
}

/**
 * Read configuration for an explicitly pre-initialization caller. Keep this
 * exception narrow: ordinary product paths must read through
 * {@link readConfig} (or {@link getConfig}) so an initialization-order defect
 * remains observable.
 */
export function getConfigBeforePlatformInit<T>(
  path: string,
  defaultValue: T,
): T {
  return tryWorkspaceRoots()?.config.get(path, defaultValue) ?? defaultValue;
}
