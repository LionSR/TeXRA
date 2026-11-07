// Node imports
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Effect, Layer } from 'effect';

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
    TEXRA_NO_UPDATE_CHECK: '1',
    USERPROFILE: paths.profile,
    XDG_CACHE_HOME: join(paths.profile, '.cache'),
    XDG_CONFIG_HOME: join(paths.profile, '.config'),
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

async function bundleDatabaseFixture() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const bundle = join(
    mkdtempSync(join(tmpdir(), 'texra-fixture-')),
    'session-database-fixture.mjs',
  );
  process.once('exit', () =>
    rmSync(dirname(bundle), { recursive: true, force: true }),
  );
  await build({
    stdin: {
      contents: `
        export { databaseLayer, globalDatabaseLayer } from '@controllers/session/databaseLayer';
        export { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
        export { Database, GlobalDatabase } from '@shared/session/database';
        export { ProcessIdentity } from '@shared/session/sessionEvents';
        export { qualifyAggregateId, SessionRowSchema } from '@shared/schemas';
        export { resolveGlobalStoragePath, resolveWorkspaceStoragePath } from '@platform/defaults/workspaceStorage';
        export { openDesktopProjectRecords } from '@desktop/main/desktopProjectRecords';
        export { nodeProcesses, processOwnerId } from '@platform/defaults/nodeProcesses';
        export { nodePlatformServices } from '@platform/defaults/nodePlatform';
        export { ToolRegistry, toolTable } from '@tools/toolTable';
        export { servicePaths } from '@texra/controllers/server/discovery';
      `,
      loader: 'ts',
      resolveDir: root,
    },
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.16',
    tsconfig: join(root, 'tsconfig.json'),
    banner: {
      js: "import { createRequire as __texraCreateRequire } from 'node:module'; const require = __texraCreateRequire(import.meta.url);",
    },
  });
  return import(pathToFileURL(bundle).href);
}

/**
 * Seed the data root (`<home>/.texra`) through the same project-record owner
 * as the application, on a handle over its global root.
 */
export async function rememberOpenProject(dataRoot, workspaceRoot) {
  const fixture = await loadDatabaseFixture();
  // The identity read and the database open spawn through the Node spawner
  // the application's runtime serves.
  await Effect.runPromise(
    Effect.gen(function* () {
      const owner = fixture.processOwnerId(
        yield* fixture.nodeProcesses.selfIdentity(),
      );
      yield* Effect.gen(function* () {
        const { values } = yield* fixture.GlobalDatabase;
        const records = fixture.openDesktopProjectRecords(values);
        yield* records.activate(workspaceRoot);
      }).pipe(
        Effect.provide(
          fixture
            .globalDatabaseLayer(fixture.resolveGlobalStoragePath(dataRoot))
            .pipe(Layer.provide(fixture.ProcessIdentity.layer(owner))),
        ),
      );
    }).pipe(Effect.provide(fixture.nodePlatformServices)),
  );
}
