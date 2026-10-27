/**
 * The window's hold on the background TeXRA service: the one it finds, or
 * one it starts from the bundle the extension ships (`serve/texra-serve.mjs`)
 * with VS Code's own runtime as Node. The service is detached, so it keeps
 * the window's tasks running after the window closes, and a window of a
 * newer build retires an older one.
 */
import * as path from 'node:path';

import { defaultNodeStorageRoot } from '@texra/platform/defaults/nodeStorage';
import {
  linkService,
  spawnService,
  type ServiceLink,
} from '@texra/controllers/server/client';
import type { GlobalValues } from '@texra-ai/harness/host';
import type { Effect, Scope } from 'effect';

/** Hold the service, starting it when none answers, for the caller's
 *  scope; the link reaches it again when it goes away. */
export function reachExtensionService(
  extensionPath: string,
): Effect.Effect<ServiceLink, Error, Scope.Scope | GlobalValues> {
  return linkService(
    defaultNodeStorageRoot(),
    spawnService(
      defaultNodeStorageRoot(),
      process.execPath,
      [path.join(extensionPath, 'serve', 'texra-serve.mjs'), 'serve'],
      { ELECTRON_RUN_AS_NODE: '1' },
    ),
  );
}
