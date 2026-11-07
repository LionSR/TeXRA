// Node imports
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { Effect, Scope, Stream } from 'effect';

// Local imports
import type { AgentDirectoriesPort, AppStateStore } from '@platform/interfaces';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { resolveGlobalStoragePath } from '@platform/defaults/workspaceStorage';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  settingsCatalog,
  type SettingsCatalog,
} from '@shared/state/stateSettings';
import type { Plugin } from '@tools/plugins';
import type { SetupPlatformShape } from '@texra/tools/setup/platform';
import { harnessBuiltins } from '@texra-ai/harness/plugins';
import type { SecretsFailed } from '@texra-ai/llm';

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
 * The real file a seed key names inside `root`. A key is a path inside the
 * root: `'/workspace/a.tex'` and `host.path('workspace/a.tex')` name the same
 * file, the first the spelling a suite writes by hand, the second one a path
 * helper built on the host produces. A key that resolves outside the root
 * throws.
 */
function seedTarget(root: string, key: string): string {
  const target = key.startsWith(root)
    ? path.resolve(key)
    : path.resolve(root, `.${path.sep}${key}`);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(
      `Seed key ${key} resolves outside the fake root; seed keys must stay inside it.`,
    );
  }
  return target;
}

/** Writes the seeded files into `root`. */
function seedRoot(
  root: string,
  files: Record<string, string | Uint8Array>,
): void {
  for (const [key, content] of Object.entries(files)) {
    const file = seedTarget(root, key);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/**
 * What an app adds to a fake host: the settings catalog its config reads,
 * the plugins its process runs, and how it reads a team's members. A suite
 * of the harness alone runs over {@link HARNESS_APP}; a suite of TeXRA's
 * tools, settings or agents names `TEXRA_APP` (`support/texraApp.ts`).
 */
export interface TestApp {
  readonly settings: SettingsCatalog;
  /** Its plugins, over the host's setup platform. */
  readonly plugins: (setup: SetupPlatformShape) => readonly Plugin[];
  readonly teamMembers?: AgentDirectoriesPort['teamMembers'];
}

/** The harness alone: its own settings rows and built-in plugins, no teams. */
export const HARNESS_APP: TestApp = Object.freeze({
  settings: settingsCatalog({ namespace: 'texra', rows: [] }),
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
  workspacePath?: string | undefined;
  /** The storage root, as a real path. Defaults under the workspace root. */
  storagePath?: string;
  /** The global-storage root, as a real path. Worker-shared by default. */
  globalStoragePath?: string;
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
 * Overrides for one fake host: the process ports above, the two
 * workspace-root ports a suite substitutes (a config it holds a handle to, a
 * hand-built state store), the process ports a root hands
 * `processLayer`, and the setup platform a setup-tool suite
 * provides. The workspace and storage paths come from `FakePlatformOptions`.
 */
export type FakeHostOverrides = Partial<FakeProcessPorts> &
  Partial<Pick<WorkspaceRoots, 'config' | 'workspaceState' | 'globalState'>> & {
    /** The store the host's `Secrets` service reads, as a root's own local. */
    readonly secrets?: PlatformSecrets;
    readonly setup?: SetupPlatformShape;
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
  return {
    workspace: Object.hasOwn(options, 'workspacePath')
      ? options.workspacePath
      : path.join(root, 'workspace'),
    storageRoot: fakeStorageRoot(),
    storage: options.storagePath ?? path.join(root, 'workspace/.texra/storage'),
    globalStorage: options.globalStoragePath ?? fakeGlobalStorage(),
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

const fakeAgentDirectories = (
  root: string,
  { teamMembers }: TestApp,
): AgentDirectoriesPort => ({
  custom: () => Effect.succeed(path.join(root, 'workspace/.texra/agents')),
  customConfigured: () => Effect.succeed(false),
  builtIn: () => Effect.succeed(path.join(root, 'workspace/resources/agents')),
  ...(teamMembers ? { teamMembers } : {}),
});

/** A host's process ports over `root`, with `options.files` seeded into it. */
export function createFakePlatform(
  root: string,
  options: FakePlatformOptions = {},
  overrides: Partial<FakeProcessPorts> = {},
): FakeProcessPorts {
  seedRoot(root, options.files ?? {});
  return {
    shutdownScope: Scope.makeUnsafe(),
    agentDirectories: fakeAgentDirectories(root, options.app ?? HARNESS_APP),
    ...overrides,
  };
}
