// Node imports
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { Effect, Scope, Stream } from 'effect';

// Local imports
import type { AgentDirectoriesPort, AppStateStore } from '@platform/interfaces';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  settingsCatalog,
  type SettingsCatalog,
} from '@shared/state/stateSettings';
import type { Plugin } from '@tools/plugins';
import { harnessBuiltins } from '@texra-ai/harness/plugins';
import type { SecretsFailed } from '@texra-ai/llm';
import type { ClientIdentity } from '@texra-ai/llm/node';

// The worker's temp home and the directories made in it, kept on the
// global object so a suite that resets its module registry finds them.
declare global {
  var __texraFakeHome__: string | undefined;
  var __texraFakeDirs__: Set<string> | undefined;
}

/**
 * One real temporary directory per worker process, holding the storage root
 * every fake host shares (its global storage, and the MCP config a test
 * process reads). Cached on `globalThis` so a suite that resets its module
 * registry keeps the same directory. It sits in the run's temp folder, which
 * the run's teardown removes (`testTempRoot.ts`): the pool ends a worker
 * without its exit handlers.
 *
 * The realpath is resolved so the paths handed out are canonical: on macOS
 * `os.tmpdir()` traverses the `/tmp` to `/private/tmp` symlink and on Windows
 * CI the 8.3 short name differs from the long form, so production code that
 * resolves either would otherwise never produce the string a suite compares
 * against.
 */
function workerTempHome(): string {
  globalThis.__texraFakeHome__ ??= realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'texra-fake-')),
  );
  return globalThis.__texraFakeHome__;
}

/**
 * A directory under the worker temp home, created on first use and
 * remembered per worker. Nothing here runs at module load: importing this
 * module must stay free of process-wide side effects, so the pure test tier
 * can reach it.
 */
function workerDir(name: string): string {
  const dir = path.join(workerTempHome(), name);
  const created = (globalThis.__texraFakeDirs__ ??= new Set<string>());
  if (!created.has(dir)) {
    mkdirSync(dir, { recursive: true });
    created.add(dir);
  }
  return dir;
}

/**
 * A fake host's own root: a fresh real directory in the run's temp folder,
 * canonical, holding the files it seeds and its default workspace. What `/`
 * meant to the in-memory filesystem this replaced. `FakeHost.layer` removes
 * it on release.
 */
export function makeHostRoot(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), 'texra-host-')));
}

/** The worker's storage root, which every fake host shares: the fake host's
 *  global storage, and the MCP config a test process reads, lie under it as
 *  a host's do under `~/.texra`. */
function fakeStorageRoot(): string {
  return workerDir('storage-root');
}

function fakeGlobalStorage(): string {
  return workerDir(
    path.relative(
      workerTempHome(),
      resolveGlobalStoragePath(fakeStorageRoot()),
    ),
  );
}

/**
 * What an app adds to a fake host: the settings catalog its config reads
 * and the plugins its process runs. A suite
 * of the harness alone runs over {@link HARNESS_APP}; a suite of TeXRA's
 * tools, settings or agents names `TEXRA_APP` (`support/texraApp.ts`).
 */
export interface TestApp {
  readonly settings: SettingsCatalog;
  /** The app its process signs in and sends model requests as. */
  readonly client: ClientIdentity;
  /** The plugins its process runs, made when the process builds. */
  readonly plugins: () => readonly Plugin[];
}

/** The harness alone: its own settings rows and built-in plugins,
 *  and the models an embedder curates (the harness curates none). */
export const HARNESS_APP: TestApp = Object.freeze({
  settings: settingsCatalog({
    namespace: 'texra',
    rows: [],
    curatedModels: ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5-5'],
  }),
  client: Object.freeze({ name: 'Test app', id: 'test-app' }),
  plugins: () => harnessBuiltins,
});

/**
 * The config every fake host reads: production's in-memory provider over
 * the app's catalog, holding each seeded value where a person's setting of
 * it would sit (the scope its row is written to, else the workspace), so it
 * resolves exactly as it does on a real host.
 */
export function fakeConfig(
  values: Record<string, unknown> = {},
  settings: SettingsCatalog = HARNESS_APP.settings,
): MemoryConfigProvider {
  const config = new MemoryConfigProvider(settings);
  for (const [key, value] of Object.entries(values)) {
    const row = settings.byKey(key);
    Effect.runSync(config.update(key, value, row?.configTarget ?? 'workspace'));
  }
  return config;
}

/** The platform's in-memory store, with the change feed an `AppStateStore`
 *  has: none, so a reader sees a write at its next read. */
export class FakeStateStore extends MemoryStateStore implements AppStateStore {
  changes(): Stream.Stream<void> {
    return Stream.succeed(undefined);
  }
}

export class FakeSecrets implements PlatformSecrets {
  /** The stored secrets, for a test to read without running an Effect. */
  readonly values = new Map<string, string>();

  constructor(values: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(values)) {
      this.values.set(key, value);
    }
  }

  get(key: string): Effect.Effect<string | undefined, SecretsFailed> {
    return Effect.sync(() => this.values.get(key));
  }

  set(key: string, value: string): Effect.Effect<void, SecretsFailed> {
    return Effect.sync(() => {
      this.values.set(key, value);
    });
  }

  delete(key: string): Effect.Effect<void, SecretsFailed> {
    return Effect.sync(() => {
      this.values.delete(key);
    });
  }

  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed> {
    return Effect.sync(() => [...this.values.keys()]);
  }
}

export interface FakePlatformOptions {
  /** The app the host runs: {@link HARNESS_APP} unless named. */
  app?: TestApp;
  config?: Record<string, unknown>;
  globalState?: Record<string, unknown>;
  workspaceState?: Record<string, unknown>;
  /**
   * Files seeded into the host's root when it is made. Keys are paths
   * inside that root: `'/workspace/a.tex'` and `host.path('workspace/a.tex')`
   * both name the same file, under the default workspace root.
   */
  files?: Record<string, string | Uint8Array>;
  secrets?: Record<string, string>;
  /**
   * The workspace root, as a real path: the host's `workspace` directory by
   * default. A suite pointing the workspace elsewhere passes a real
   * directory it owns (its own temp dir, or `process.cwd()`).
   */
  workspaceRoot?: string | undefined;
  /**
   * The storage root (`~/.texra` on a real host), as a real path; the
   * workspace's storage and the global storage lie under it as production
   * places them. Unnamed, the root is the worker's, which every fake host
   * shares, and the workspace's storage is under the host's own root.
   */
  storageRoot?: string;
  /** The workspace's storage alone, as a real path, for a suite that puts it
   *  outside any storage root. */
  storagePath?: string;
}

/** A fake host's shutdown scope and the port it serves as
 *  `AgentDirectories`, held per host because hosts change per test. */
export interface FakeProcessPorts {
  /** The host's shutdown: a command that must act before its sessions close
   *  registers in a child scope of this; closing it is the shutdown. */
  readonly shutdownScope: Scope.Closeable;
  readonly agentDirectories: AgentDirectoriesPort;
}

/**
 * Overrides for one fake host: the process ports above, the
 * workspace-root ports a suite substitutes (a config it holds a handle to, a
 * hand-built state store), and the secrets a root hands `processLayer`. The
 * workspace and storage paths come from `FakePlatformOptions`.
 */
export type FakeHostOverrides = Partial<FakeProcessPorts> &
  Partial<Pick<WorkspaceRoots, 'config' | 'workspaceState' | 'globalState'>> & {
    /** The store the host's `Secrets` service reads, as a root's own local. */
    readonly secrets?: PlatformSecrets;
  };

/** The workspace roots a fake host holds beside its platform, its default
 *  workspace and storage under `root` (a fresh one unless named). */
export function createFakeWorkspaceRoots(
  options: FakePlatformOptions = {},
  overrides: Partial<
    Pick<
      WorkspaceRoots,
      'config' | 'workspaceState' | 'repoState' | 'globalState'
    >
  > = {},
  root: string = makeHostRoot(),
): WorkspaceRoots {
  const workspace = Object.hasOwn(options, 'workspaceRoot')
    ? options.workspaceRoot
    : path.join(root, 'workspace');
  const { storageRoot } = options;
  return {
    workspace,
    storageRoot: storageRoot ?? fakeStorageRoot(),
    storage:
      options.storagePath ??
      (storageRoot === undefined
        ? path.join(root, 'workspace/.texra/storage')
        : resolveWorkspaceStoragePath(storageRoot, workspace)),
    globalStorage:
      storageRoot === undefined
        ? fakeGlobalStorage()
        : resolveGlobalStoragePath(storageRoot),
    config:
      overrides.config ??
      fakeConfig(options.config, (options.app ?? HARNESS_APP).settings),
    workspaceState:
      overrides.workspaceState ?? new FakeStateStore(options.workspaceState),
    repoState: overrides.repoState ?? new FakeStateStore(),
    globalState:
      overrides.globalState ?? new FakeStateStore(options.globalState),
  };
}
