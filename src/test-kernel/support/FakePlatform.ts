// Node imports
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { canonicalConfigKey } from '@shared/config/configKeys';
import type { SettingHost } from '@shared/state/stateSettings';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import type { SetupPlatformShape } from '@texra/tools/setup/platform';
import type { SecretsFailed } from '@texra-ai/llm';

/**
 * One real temporary directory per worker process, holding both the fake
 * filesystem root and the shared global-storage directory. Cached on
 * `globalThis` so a suite that resets its module registry keeps the same
 * directories, and removed when the worker exits.
 *
 * The realpath is resolved so the paths handed out are canonical: on macOS
 * `os.tmpdir()` traverses the `/tmp` to `/private/tmp` symlink and on Windows
 * CI the 8.3 short name differs from the long form, so production code that
 * resolves either would otherwise never produce the string a suite compares
 * against.
 */
function workerTempHome(): string {
  const globals = globalThis as { __texraFakeHome__?: string };
  if (globals.__texraFakeHome__ === undefined) {
    const home = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'texra-fake-')),
    );
    globals.__texraFakeHome__ = home;
    process.on('exit', () => rmSync(home, { recursive: true, force: true }));
  }
  return globals.__texraFakeHome__;
}

/**
 * A directory under the worker temp home, created on first use and remembered
 * per worker so the thousands of per-test fake hosts do not each pay for a
 * `mkdir`. Nothing here runs at module load: importing this module must stay
 * free of process-wide side effects, so the pure test tier can reach it.
 */
function workerDir(name: string): string {
  const globals = globalThis as { __texraFakeDirs__?: Set<string> };
  const dir = path.join(workerTempHome(), name);
  const created = (globals.__texraFakeDirs__ ??= new Set<string>());
  if (!created.has(dir)) {
    mkdirSync(dir, { recursive: true });
    created.add(dir);
  }
  return dir;
}

/**
 * The real directory every fake host's files live in: what `/` meant to the
 * in-memory filesystem this replaced. Emptied whenever a fake platform is
 * built, so a host starts from the files it seeds and nothing else.
 */
function fakeRoot(): string {
  return workerDir('root');
}

/**
 * A real path inside the {@link fakeRoot}. `fakePath('workspace/a.tex')` is the
 * path a `files` seed keyed `'/workspace/a.tex'` writes to, and is what a
 * suite asserting on an absolute path compares against.
 */
export function fakePath(...segments: string[]): string {
  return path.join(fakeRoot(), ...segments);
}

/**
 * A real directory: instance-presence sockets are genuine OS objects that live
 * under the global storage root even when everything else is faked.
 * Worker-shared so the hosts that never touch presence share the one directory.
 */
/** The worker's storage root: the fake host's global storage, and the MCP
 *  config a process reads, lie under it as a host's do under `~/.texra`. */
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
 * The real file a seed key names. Keys are paths inside the {@link fakeRoot},
 * so `'/workspace/a.tex'` and `fakePath('workspace/a.tex')` name the same file:
 * the first is the spelling a suite writes by hand, the second the one a path
 * helper built on the installed roots produces.
 */
function seedTarget(key: string): string {
  const root = fakeRoot();
  if (key.startsWith(root)) {
    // A key this harness handed out (fakePath(...)) or built from one: it is
    // still confined below, a prefix match alone is not containment.
    return confineToRoot(root, path.resolve(key), key);
  }
  // A path this harness handed out but from outside the fake root -- the
  // worker temp home itself, or a sibling of the root under it -- would be
  // nested under the root silently. Every other absolute key ('/tmp/run/x'
  // included) is a path inside the fake root, not a real one.
  if (key.startsWith(workerTempHome())) {
    throw new Error(
      `Seed key ${key} is a real path under the harness temp home; seed keys are paths inside the fake root (use fakePath).`,
    );
  }
  return confineToRoot(root, path.resolve(root, `.${path.sep}${key}`), key);
}

/** The resolved target, or a throw when it is not the root or a descendant. */
function confineToRoot(root: string, target: string, key: string): string {
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(
      `Seed key ${key} resolves outside the fake root; seed keys must stay inside it.`,
    );
  }
  return target;
}

/** Empties the {@link fakeRoot} and writes the seeded files into it. */
function seedFakeRoot(files: Record<string, string | Uint8Array>): void {
  const root = fakeRoot();
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const [key, content] of Object.entries(files)) {
    const file = seedTarget(key);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/**
 * The config every fake host reads: production's in-memory provider over
 * TeXRA's catalog, holding each seeded value where a person's setting of it
 * would sit (the scope its row is written to, else the workspace), so it
 * resolves exactly as it does on a real host.
 */
export function fakeConfig(
  values: Record<string, unknown> = {},
): MemoryConfigProvider {
  const config = new MemoryConfigProvider(TEXRA_SETTINGS);
  for (const [key, value] of Object.entries(values)) {
    const row = TEXRA_SETTINGS.byKey(canonicalConfigKey(key));
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
  config?: Record<string, unknown>;
  globalState?: Record<string, unknown>;
  workspaceState?: Record<string, unknown>;
  /**
   * Files seeded into the fake root before the host is installed. Keys
   * are paths inside that root: `'/workspace/a.tex'` and
   * `fakePath('workspace/a.tex')` both name the same file, under the default
   * workspace root.
   */
  files?: Record<string, string | Uint8Array>;
  secrets?: Record<string, string>;
  /**
   * The process environment the harness ConfigProvider serves; `{}` when
   * absent, so no suite reads the developer's shell.
   */
  env?: Record<string, string>;
  /**
   * The workspace root, as a real path: `fakePath('workspace')` by default.
   * A suite pointing the workspace elsewhere passes a real directory it owns
   * (a `fakePath(...)` subdirectory, its own temp dir, or `process.cwd()`).
   */
  workspacePath?: string | undefined;
  /** The storage root, as a real path. Defaults under the workspace root. */
  storagePath?: string;
  /** The global-storage root, as a real path. Worker-shared by default. */
  globalStoragePath?: string;
  /** The product host the roots name; the extension's by default. */
  host?: SettingHost;
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

/** The workspace roots a fake host installs beside its platform. */
export function createFakeWorkspaceRoots(
  options: FakePlatformOptions = {},
  overrides: Partial<
    Pick<
      WorkspaceRoots,
      'config' | 'workspaceState' | 'repoState' | 'globalState'
    >
  > = {},
): WorkspaceRoots {
  return {
    host: options.host ?? 'vscode',
    workspace: Object.hasOwn(options, 'workspacePath')
      ? options.workspacePath
      : fakePath('workspace'),
    storageRoot: fakeStorageRoot(),
    storage: options.storagePath ?? fakePath('workspace/.texra/storage'),
    globalStorage: options.globalStoragePath ?? fakeGlobalStorage(),
    config: overrides.config ?? fakeConfig(options.config),
    workspaceState:
      overrides.workspaceState ?? new FakeStateStore(options.workspaceState),
    repoState: overrides.repoState ?? new FakeStateStore(),
    globalState:
      overrides.globalState ?? new FakeStateStore(options.globalState),
  };
}

const FAKE_AGENT_DIRECTORIES: AgentDirectoriesPort = {
  custom: () => Effect.sync(() => fakePath('workspace/.texra/agents')),
  customConfigured: () => Effect.succeed(false),
  builtIn: () => Effect.sync(() => fakePath('workspace/resources/agents')),
};

export function createFakePlatform(
  options: FakePlatformOptions = {},
  overrides: Partial<FakeProcessPorts> = {},
): FakeProcessPorts {
  seedFakeRoot(options.files ?? {});
  return {
    shutdownScope: Scope.makeUnsafe(),
    agentDirectories: FAKE_AGENT_DIRECTORIES,
    ...overrides,
  };
}
