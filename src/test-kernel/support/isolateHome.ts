/**
 * The kernel suite never touches the real home. The first setup file of
 * every kernel suite: before any repository module loads, each worker
 * points HOME, USERPROFILE, the XDG directories and the Windows profile
 * folders at a temp folder of its own, so `~/.texra` (the global store, the
 * credential file, the service socket) resolves inside it. A worker keeps
 * one folder for every file it runs, since a module it already loaded may
 * hold a path resolved from it. The worker's pid marks the swap as its own:
 * an environment inherited from elsewhere never stands in for it.
 *
 * It then fails loudly if anything still resolves to the real home or a
 * real TeXRA directory: the environment, `os.homedir()`, or the global
 * TeXRA root a host opens. The temp folder itself may sit under the real
 * home (Windows keeps temp in `%USERPROFILE%\AppData\Local\Temp`).
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The directories the swap replaces. */
const DIRECTORY_KEYS = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'APPDATA',
  'LOCALAPPDATA',
] as const;
/** This worker's pid once it swapped; the real directories it replaced. */
const SWAPPED_BY = 'TEXRA_TEST_HOME_SWAPPED_BY';
const REAL_DIRECTORIES = 'TEXRA_TEST_REAL_DIRECTORIES';

if (process.env[SWAPPED_BY] !== String(process.pid)) {
  const real: Record<string, string> = { home: os.homedir() };
  for (const key of DIRECTORY_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== '') real[key] = value;
  }
  const home = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), 'texra-test-home-')),
  );
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    [REAL_DIRECTORIES]: JSON.stringify(real),
    [SWAPPED_BY]: String(process.pid),
  });
  process.once('exit', () => rmSync(home, { recursive: true, force: true }));
}

// Loaded only now, so no module of the repository reads the home first.
const { defaultNodeStorageRoot } =
  await import('@platform/defaults/nodeStorage');
const { resolveGlobalStoragePath } =
  await import('@platform/defaults/workspaceStorage');

// cast: written above by this worker, from strings only.
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
