/**
 * The kernel suite never touches the real home. The first setup file of
 * every project: before any suite module loads, each worker points HOME,
 * USERPROFILE, the XDG directories and the Windows profile folders at a
 * temp folder of its own, so `~/.texra` (the global store, the credential
 * file, the service socket) resolves inside it. A worker keeps one folder
 * for every file it runs, since a module it already loaded may hold a path
 * resolved from it.
 *
 * It then fails loudly if anything still resolves to the real home: the
 * environment, `os.homedir()`, or the global TeXRA root a host opens.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REAL_HOME_KEY = 'TEXRA_TEST_REAL_HOME';

if (process.env[REAL_HOME_KEY] === undefined) {
  process.env[REAL_HOME_KEY] = os.homedir();
  const home = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), 'texra-test-home-')),
  );
  const directories: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  };
  Object.assign(process.env, directories);
  process.once('exit', () => rmSync(home, { recursive: true, force: true }));
}

// Loaded only now, so no module of the repository reads the home first.
const { defaultNodeStorageRoot } =
  await import('@platform/defaults/nodeStorage');
const { resolveGlobalStoragePath } =
  await import('@platform/defaults/workspaceStorage');
const realHome = process.env[REAL_HOME_KEY] ?? os.homedir();
const underRealHome = (value: string | undefined): boolean =>
  value !== undefined &&
  realHome !== '' &&
  path.resolve(value).startsWith(path.resolve(realHome));
const leaks = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  'os.homedir()': os.homedir(),
  'global storage': resolveGlobalStoragePath(defaultNodeStorageRoot()),
};
const leaked = Object.entries(leaks).filter(([, value]) =>
  underRealHome(value),
);
if (leaked.length > 0)
  throw new Error(
    `The kernel suite would reach the real home (${realHome}) through ${leaked
      .map(([name, value]) => `${name}=${value}`)
      .join(', ')}: a test must never read or write the user's ~/.texra.`,
  );
