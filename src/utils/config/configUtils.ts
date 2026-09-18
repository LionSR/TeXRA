// Local imports
import type { ConfigProvider } from '@platform/interfaces';
import { tryProcessWorkspaceRoots } from '@platform/workspaceRoots';

/**
 * Read a configuration path over an explicit provider: the configuration of
 * the workspace the caller was handed (a tool call's `roots.config`, a run's
 * `session.roots.config`, a host command's `session.roots.config`), resolved
 * by that provider's own documented order — configured value, catalog
 * default, then the caller's fallback.
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
 * catalog and reads through `readSettingFrom`, which validates it against
 * the row's schema.
 *
 * @param config The workspace configuration the caller holds
 * @param path Configuration path (e.g., 'agents' or 'api.engine')
 * @param defaultValue Optional fallback for keys the catalog does not own
 * @returns The configured, catalog-default, or caller-fallback value
 */
export function readConfig<T>(
  config: ConfigProvider,
  path: string,
  defaultValue?: T,
): T {
  return config.get<T>(path, defaultValue as T);
}

/**
 * Read configuration for an explicitly pre-initialization caller, over the
 * process roots the composition root installed. A logger write can precede
 * any session, so there is no caller to take a
 * configuration from here; a process whose roots are not installed yet reads
 * the caller's default. Keep this exception narrow: ordinary product paths
 * must read through {@link readConfig} so an initialization-order defect
 * remains observable.
 */
export function getConfigBeforePlatformInit<T>(
  path: string,
  defaultValue: T,
): T {
  return (
    tryProcessWorkspaceRoots()?.config.get(path, defaultValue) ?? defaultValue
  );
}
