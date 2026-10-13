// The directories a temporary home replaces, so `~/.texra` (the global
// store, the credential file, the service socket), the XDG directories and
// the Windows profile folders all resolve inside it. One list for the
// kernel suite (`src/test-kernel/support/isolateHome.ts`), the VS Code
// host e2e runner (`scripts/vscode-host-e2e-runner.mjs`) and the CLI's
// validation scripts (`isolateProcessHome`).
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** The environment keys the swap replaces. */
export const HOME_DIRECTORY_KEYS = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'APPDATA',
  'LOCALAPPDATA',
];

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

/**
 * Point this process at a fresh temporary home, removed when it exits, so a
 * script and every child it spawns (`texra` above all, at any spawn site)
 * resolve `~/.texra` inside it and never touch the user's TeXRA data. The
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
  Object.assign(process.env, isolatedHomeEnv(home), caches);
  process.once('exit', () => rmSync(home, { recursive: true, force: true }));
  return home;
}
