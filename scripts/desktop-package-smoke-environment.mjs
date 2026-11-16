// Node imports
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Effect } from 'effect';

import { bundleFixture } from './bundle-fixture.mjs';
import { testLaunchEnv } from './isolated-home.mjs';

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
    ...testLaunchEnv(paths.profile),
    ELECTRON_ENABLE_LOGGING: '1',
    NODE_ENV: 'production',
  };
}

let fixture;

/**
 * The production modules the fixtures drive, bundled once per process:
 * Playwright's ESM loader cannot directly import the root's CommonJS-shaped
 * TS modules. Every caller shares the one bundle, which is about 10 MB.
 */
export function loadDatabaseFixture() {
  fixture ??= bundleDatabaseFixture();
  return fixture;
}

function bundleDatabaseFixture() {
  // Playwright's config externalises the bundle by this file name.
  const bundle = join(
    mkdtempSync(join(tmpdir(), 'texra-fixture-')),
    'session-database-fixture.mjs',
  );
  process.once('exit', () =>
    rmSync(dirname(bundle), { recursive: true, force: true }),
  );
  return bundleFixture('sessionDatabase', bundle);
}

/**
 * Seed the data root (`<home>/.texra`) through the same project-record owner
 * as the application, on a handle over its global root.
 */
export async function rememberOpenProject(dataRoot, workspaceRoot) {
  const fixture = await loadDatabaseFixture();
  // The database open spawns through the Node spawner the application's
  // runtime serves.
  await Effect.runPromise(
    Effect.gen(function* () {
      const { values } = yield* fixture.GlobalDatabase;
      const records = fixture.openDesktopProjectRecords(values);
      yield* records.activate(workspaceRoot);
    }).pipe(
      Effect.provide(
        fixture.globalDatabaseLayer(fixture.resolveGlobalStoragePath(dataRoot)),
      ),
      Effect.provide(fixture.nodePlatformServices),
    ),
  );
}
