/**
 * The kernel suite never touches the real home. The first setup file of
 * every suite in the `kernel` and `isolated` projects: before any repository
 * module loads, each worker points HOME, USERPROFILE, the XDG directories and
 * the Windows profile folders at a temp folder of its own, so `~/.texra` (the
 * global store, the credential file, the service socket) resolves inside it.
 * A worker keeps one folder for every file it runs, since a module it already
 * loaded may hold a path resolved from it. The worker's pid marks the swap as
 * its own: an environment inherited from elsewhere never stands in for it.
 *
 * It imports none of the harness or app modules: the next setup file,
 * `homeIsolationCheck.ts`, loads the ones it checks once the swap is done,
 * and fails loudly if anything still resolves to the real home.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  HOME_DIRECTORY_KEYS,
  isolatedHomeEnv,
} from '../../../scripts/isolated-home.mjs';

/** This worker's pid once it swapped. */
const SWAPPED_BY = 'TEXRA_TEST_HOME_SWAPPED_BY';
/** The real directories the swap replaced, as JSON: the home and each
 *  directory key that was set. */
export const REAL_DIRECTORIES = 'TEXRA_TEST_REAL_DIRECTORIES';

if (process.env[SWAPPED_BY] !== String(process.pid)) {
  const real: Record<string, string> = { home: os.homedir() };
  for (const key of HOME_DIRECTORY_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== '') real[key] = value;
  }
  const home = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), 'texra-test-home-')),
  );
  Object.assign(process.env, {
    ...isolatedHomeEnv(home),
    [REAL_DIRECTORIES]: JSON.stringify(real),
    [SWAPPED_BY]: String(process.pid),
  });
  // Under the run's temp folder, which the run's teardown removes
  // (`testTempRoot.ts`): the pool ends a worker without its exit handlers.
}
