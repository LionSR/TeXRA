import * as path from 'node:path';

import { Effect } from 'effect';

import { AppState, type StateReadFailed } from '@platform/interfaces';
import { readDisabledTools } from '@tools/plugins';
import { ToolRegistry } from '@tools/toolTable';

/** The one bundled agent directory under a host's packaged resources. */
export const BUNDLED_AGENTS_DIRECTORY = 'agents' as const;

/**
 * The roots of the `builtIn` source: the core bundled directory the
 * host's agent directories name, then each tool plugin's that is on, at
 * `<resources>/plugins/<id>/agents` under the host's packaged resources root
 * (a plugin that ships no agents has no such directory, which scans as none;
 * an unpackaged host has none). Their agents are bundled agents like the
 * core ones. A plugin is one on/off unit, so the user's switch
 * (`texra.tools.disabled`) that withholds its tools drops its agents too,
 * wherever agents are found: the catalog's scan and a copy's source root
 * alike (`agentSourceRoots`). Toggling a plugin refreshes the catalog. A
 * failed dependency probe does not drop them: a probe answers per workspace,
 * the catalog is the process's, and a plugin's agents may be what helps the
 * user set the dependency up.
 */
export const enabledBuiltInRoots = (
  coreDirectory: string,
  resourcesRoot: string | undefined,
): Effect.Effect<readonly string[], StateReadFailed, AppState | ToolRegistry> =>
  Effect.map(
    Effect.all([
      AppState.pipe(Effect.flatMap(readDisabledTools)),
      ToolRegistry,
    ]),
    ([disabled, registry]) => [
      coreDirectory,
      ...(resourcesRoot === undefined || resourcesRoot === ''
        ? []
        : [...registry.entries.keys()].flatMap((id) =>
            disabled.has(id)
              ? []
              : [path.join(resourcesRoot, 'plugins', id, 'agents')],
          )),
    ],
  );
