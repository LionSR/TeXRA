// The directories a temporary home replaces, so `~/.texra` (the global
// store, the credential file, the service socket), the XDG directories and
// the Windows profile folders all resolve inside it. One list for the
// kernel suite (`src/test-kernel/support/isolateHome.ts`) and the VS Code
// host e2e runner (`scripts/vscode-host-e2e-runner.mjs`).
import path from 'node:path';

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
