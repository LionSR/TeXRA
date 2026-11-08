/**
 * The desktop app's hold on the background TeXRA service: the one it finds,
 * or one it starts from the bundle it ships (`Resources/serve/`, beside its
 * `resources/`) with Electron as Node. The service is detached, so it keeps
 * the app's tasks running after the app quits, and an app of a newer build
 * retires an older one.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';
import { Effect, type Scope } from 'effect';

import {
  linkService,
  spawnService,
  type ServiceLink,
} from '@texra/controllers/server/client';
import type { GlobalValues } from '@texra-ai/harness/host';

/** The service bundle: the packaged app's, or the extension build's in a
 *  development run, as `app.isPackaged` says. */
const serviceBundle = (mainDir: string): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'serve', 'texra-serve.mjs')
    : path.join(mainDir, '../../../extension/serve/texra-serve.mjs');

/**
 * Hold the service of `dataRoot`, starting it when none answers, for the
 * caller's scope; the link reaches it again when it goes away.
 */
export function reachDesktopService(
  dataRoot: string,
  mainDir: string,
): Effect.Effect<ServiceLink, Error, Scope.Scope | GlobalValues> {
  return Effect.suspend(() => {
    const bundle = serviceBundle(mainDir);
    if (!existsSync(bundle))
      return Effect.fail(
        new Error(`this build has no service bundle at ${bundle}`),
      );
    return linkService(
      dataRoot,
      spawnService(dataRoot, process.execPath, [bundle, 'serve'], {
        ELECTRON_RUN_AS_NODE: '1',
      }),
      Effect.logWarning,
    );
  });
}
