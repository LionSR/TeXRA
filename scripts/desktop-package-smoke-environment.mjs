// Node imports
import { join } from 'node:path';

const PASSTHROUGH_ENV_NAMES = new Set([
  'COLORTERM',
  'COMSPEC',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'DYLD_LIBRARY_PATH',
  'LANG',
  'LANGUAGE',
  'LC_ADDRESS',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_IDENTIFICATION',
  'LC_MEASUREMENT',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NAME',
  'LC_NUMERIC',
  'LC_PAPER',
  'LC_TELEPHONE',
  'LC_TIME',
  'LD_LIBRARY_PATH',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'WAYLAND_DISPLAY',
  'WINDIR',
  'XAUTHORITY',
  'XDG_CURRENT_DESKTOP',
  'XDG_DATA_DIRS',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
]);

function mayPassThrough(name) {
  return PASSTHROUGH_ENV_NAMES.has(name.toUpperCase());
}

/**
 * Build the packaged-smoke child environment from an explicit system-variable
 * allowlist. Signing credentials and future job-level secrets are excluded by
 * default rather than depending on a synchronized denylist.
 */
export function buildDesktopSmokeEnvironment(sourceEnvironment, paths) {
  const environment = Object.fromEntries(
    Object.entries(sourceEnvironment).filter(
      ([name, value]) => value != null && mayPassThrough(name),
    ),
  );

  return {
    ...environment,
    APPDATA: join(paths.profile, 'AppData', 'Roaming'),
    ELECTRON_ENABLE_LOGGING: '1',
    HOME: paths.profile,
    LOCALAPPDATA: join(paths.profile, 'AppData', 'Local'),
    NODE_ENV: 'production',
    TEXRA_DESKTOP_E2E_USER_DATA_PATH: paths.userData,
    TEXRA_DISABLE_KEYCHAIN: '1',
    TEXRA_NO_UPDATE_CHECK: '1',
    USERPROFILE: paths.profile,
    XDG_CACHE_HOME: join(paths.profile, '.cache'),
    XDG_CONFIG_HOME: join(paths.profile, '.config'),
  };
}
