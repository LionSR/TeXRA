/**
 * The window's hold on the background TeXRA service: the one it finds, or
 * one it starts from the bundle the extension ships (`serve/texra-serve.mjs`)
 * with VS Code's own runtime as Node. The service is detached, so it keeps
 * the window's tasks running after the window closes, and a window of a
 * newer extension retires an older one by version.
 */
import * as path from 'node:path';

import {
  ensureService,
  spawnService,
  type ServiceConnection,
} from '@controllers/server/client';
import { DEFAULT_NODE_STORAGE_ROOT } from '@platform/defaults/nodeStorage';
import type { Effect, Scope } from 'effect';

/** Connect to the service, starting it when none answers, for the
 *  caller's scope. */
export function reachExtensionService(
  extensionPath: string,
  version: string,
): Effect.Effect<ServiceConnection, Error, Scope.Scope> {
  return ensureService(
    DEFAULT_NODE_STORAGE_ROOT,
    version,
    spawnService(
      DEFAULT_NODE_STORAGE_ROOT,
      process.execPath,
      [path.join(extensionPath, 'serve', 'texra-serve.mjs'), 'serve'],
      { ELECTRON_RUN_AS_NODE: '1' },
    ),
  );
}
