import * as path from 'node:path';

import { Effect } from 'effect';

import { AppState } from '@platform/interfaces';
import { readDisabledTools } from '@tools/plugins';

/** The one bundled agent directory under a host's packaged resources. */
export const BUNDLED_AGENTS_DIRECTORY = 'agents' as const;

/**
 * The agent directories of the tool plugins, at
 * `<resources>/plugins/<id>/agents`, by plugin id (a plugin that ships no
 * agents has no such directory, which scans as none). Their agents are bundled
 * agents like the core ones: the `builtIn` source. The process's agent-catalog follower
 * (`@tools/agentCatalogFollower`) installs them under the host's packaged
 * resources root as it is built, before any reload; the plugin ids cross as strings, so `@agent/index` takes no edge
 * to `@tools`. The default installs none.
 */
let pluginAgentDirectories: ReadonlyMap<string, string> = new Map();

export function installPluginAgentDirectories(
  resourcesPath: string,
  pluginIds: readonly string[],
): void {
  pluginAgentDirectories = new Map(
    pluginIds.map((id) => [
      id,
      path.join(resourcesPath, 'plugins', id, 'agents'),
    ]),
  );
}

/**
 * The roots of the `builtIn` source: the core bundled directory the
 * host's agent directories name, then each installed plugin's that is on. A
 * plugin is one on/off unit, so the user's switch (`texra.tools.disabled`)
 * that withholds its tools drops its agents too, wherever agents are found:
 * the catalog's scan and a copy's source root alike (`agentSourceRoots`).
 * Toggling a plugin refreshes the catalog. A failed dependency probe does
 * not drop them: a probe answers per workspace, the catalog is the
 * process's, and a plugin's agents may be what helps the user set the
 * dependency up.
 */
export const enabledBuiltInRoots = (coreDirectory: string) =>
  AppState.pipe(
    Effect.flatMap(readDisabledTools),
    Effect.map((disabled): readonly string[] => [
      coreDirectory,
      ...[...pluginAgentDirectories].flatMap(([id, directory]) =>
        disabled.has(id) ? [] : [directory],
      ),
    ]),
  );
