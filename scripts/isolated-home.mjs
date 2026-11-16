// The environment a test launch of TeXRA runs under: every home directory
// key pointed inside a temporary home, so `~/.texra` (the global store, the
// credential file, the service socket), the XDG directories and the Windows
// profile folders all resolve inside it, and the switches that keep a test
// launch from reporting usage or checking for updates.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** Every directory key pointed inside `home`. */
export function isolatedHomeEnv(home) {
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  };
}

/** The environment keys the swap replaces. */
export const HOME_DIRECTORY_KEYS = Object.freeze(
  Object.keys(isolatedHomeEnv('')),
);

/**
 * What a test launch of TeXRA (the CLI, the desktop app, a VS Code window)
 * is given so it touches no real profile and phones nothing home: the
 * isolated home, no usage reports, no update check. A launch site spreads
 * it and adds only what is its own.
 */
export function testLaunchEnv(home) {
  return {
    ...isolatedHomeEnv(home),
    TEXRA_NO_TELEMETRY: '1',
    TEXRA_NO_UPDATE_CHECK: '1',
  };
}

/**
 * Point this process at a fresh temporary home, removed when it exits, so a
 * script and every child it spawns (`texra` above all, at any spawn site)
 * resolve `~/.texra` inside it, never touch the user's TeXRA data, and
 * report no usage. The
 * package managers keep the caches the real home gave them (corepack's,
 * pnpm's and npm's), so a build or an install the script runs reads them as
 * before. Returns the temporary home.
 */
export function isolateProcessHome() {
  const real = os.homedir();
  const windows = process.platform === 'win32';
  const local = process.env.LOCALAPPDATA ?? path.join(real, 'AppData', 'Local');
  const cache = process.env.XDG_CACHE_HOME ?? path.join(real, '.cache');
  const data = process.env.XDG_DATA_HOME ?? path.join(real, '.local', 'share');
  const pnpmHome = windows
    ? path.join(local, 'pnpm')
    : process.platform === 'darwin'
      ? path.join(real, 'Library', 'pnpm')
      : path.join(data, 'pnpm');
  const caches = {
    COREPACK_HOME:
      process.env.COREPACK_HOME ??
      path.join(windows ? local : cache, 'node', 'corepack'),
    PNPM_HOME: process.env.PNPM_HOME ?? pnpmHome,
    npm_config_cache:
      process.env.npm_config_cache ??
      (windows ? path.join(local, 'npm-cache') : path.join(real, '.npm')),
  };
  const home = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), 'texra-script-home-')),
  );
  Object.assign(process.env, testLaunchEnv(home), caches);
  process.once('exit', () => rmSync(home, { recursive: true, force: true }));
  return home;
}
