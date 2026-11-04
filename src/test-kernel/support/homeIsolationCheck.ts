/**
 * The second setup file of every suite in the `kernel` and `isolated`
 * projects: it fails loudly if anything still resolves to the real home or a
 * real TeXRA directory once `isolateHome.ts` swapped it out: the environment,
 * `os.homedir()`, or the global TeXRA root a host opens. Vitest runs the
 * setup files in order, so the modules this one imports load only after the
 * swap, and none of them reads the home first. The temp folder itself may sit
 * under the real home (Windows keeps temp in
 * `%USERPROFILE%\AppData\Local\Temp`).
 */
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveGlobalStoragePath } from '@platform/defaults/workspaceStorage';
import { defaultNodeStorageRoot } from '@texra/platform/defaults/nodeStorage';
import { HOME_DIRECTORY_KEYS as DIRECTORY_KEYS } from '../../../scripts/isolated-home.mjs';
import { REAL_DIRECTORIES } from './isolateHome';

// cast: written by `isolateHome.ts` in this worker, from strings only.
const real = JSON.parse(process.env[REAL_DIRECTORIES] ?? '{}') as Record<
  string,
  string | undefined
>;
const same = (a: string, b: string): boolean =>
  path.relative(path.resolve(a), path.resolve(b)) === '';
const inside = (dir: string, value: string): boolean => {
  const relative = path.relative(path.resolve(dir), path.resolve(value));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};
/** The real TeXRA directories: `~/.texra` and a `texra` folder in each real
 *  XDG or AppData directory. */
const realTexraDirectories = [
  path.join(real.home ?? os.homedir(), '.texra'),
  ...DIRECTORY_KEYS.filter((key) => key !== 'HOME' && key !== 'USERPROFILE')
    .map((key) => real[key])
    .filter((dir): dir is string => dir !== undefined)
    .flatMap((dir) => [path.join(dir, 'texra'), path.join(dir, 'TeXRA')]),
];
const realDirectory = (name: string): string | undefined =>
  name === 'os.homedir()' ? real.home : real[name];
const resolved: Record<string, string | undefined> = {
  ...Object.fromEntries(DIRECTORY_KEYS.map((key) => [key, process.env[key]])),
  'os.homedir()': os.homedir(),
  'global storage': resolveGlobalStoragePath(defaultNodeStorageRoot()),
};
const leaked = Object.entries(resolved).filter(([name, value]) => {
  if (value === undefined) return false;
  const was = realDirectory(name);
  return (
    (was !== undefined && same(was, value)) ||
    (real.home !== undefined && same(real.home, value)) ||
    realTexraDirectories.some((dir) => inside(dir, value))
  );
});
if (leaked.length > 0)
  throw new Error(
    `The kernel suite would reach the real home (${real.home}) through ${leaked
      .map(([name, value]) => `${name}=${value}`)
      .join(', ')}: a test must never read or write the user's TeXRA data.`,
  );
