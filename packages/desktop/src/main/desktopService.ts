/**
 * The desktop app's hold on the background TeXRA service: the one it finds,
 * or one it starts from the bundle it ships (`Resources/serve/`, beside its
 * `resources/`) with Electron as Node. The service is detached, so it keeps
 * the app's tasks running after the app quits, and an app of a newer build
 * retires an older one.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { Effect, type Scope } from 'effect';

import { DEFAULT_NODE_STORAGE_ROOT } from '@platform/defaults/nodeStorage';
import {
  linkService,
  spawnService,
  type ServiceLink,
} from '@texra/controllers/server/client';

/** The service bundle: the packaged app's, or the extension build's in a
 *  development run. */
function serviceBundle(mainDir: string): string | undefined {
  return [
    path.join(process.resourcesPath, 'serve', 'texra-serve.mjs'),
    path.join(mainDir, '../../../extension/serve/texra-serve.mjs'),
  ].find((candidate) => existsSync(candidate));
}

/**
 * Hold the service of `dataRoot`, starting it when none answers, for the
 * caller's scope; the link reaches it again when it goes away. Only the user's own `~/.texra` has one: a profile kept
 * elsewhere (a test's) runs its tasks in the app.
 */
export function reachDesktopService(
  dataRoot: string,
  mainDir: string,
): Effect.Effect<ServiceLink, Error, Scope.Scope> {
  return Effect.suspend(() => {
    if (dataRoot !== DEFAULT_NODE_STORAGE_ROOT)
      return Effect.fail(
        new Error(
          `the app keeps its data in ${dataRoot}, outside ${DEFAULT_NODE_STORAGE_ROOT}`,
        ),
      );
    const bundle = serviceBundle(mainDir);
    if (bundle === undefined)
      return Effect.fail(new Error('this build ships no service bundle'));
    return linkService(
      dataRoot,
      spawnService(dataRoot, process.execPath, [bundle, 'serve'], {
        ELECTRON_RUN_AS_NODE: '1',
      }),
    );
  });
}
