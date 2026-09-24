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
import { Effect } from 'effect';

// Local imports
import type { SupabaseAuthShape } from '@auth/SupabaseAuth';
import type { ModelOptionStores } from '@model/computeModelOptions';
import {
  type AgentDirectoriesPort,
  type AgentResumePort,
  type ConfigInspection,
  type ConfigProvider,
  type ConfigTarget,
  ConfigWriteFailed,
  type LifecycleHost,
  type StateStore,
  type StateWriteFailed,
} from '@platform/interfaces';
import type { LanguageModelPort } from '@platform/languageModel';
import type { PlatformSecrets, SecretsFailed } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { getCoreSettingDefault } from '@shared/state/stateSettings';
import type { SetupPlatformShape } from '@tools/setup/platform';

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
function workerDir(name: 'root' | 'global-storage'): string {
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
function fakeGlobalStorage(): string {
  return workerDir('global-storage');
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

export class FakeConfigProvider implements ConfigProvider {
  private readonly values = new Map<string, unknown>();

  private readonly targets = new Map<string, ConfigTarget>();

  constructor(values: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(values)) {
      this.values.set(key, value);
      this.targets.set(key, 'workspace');
    }
  }

  get<T>(key: string, defaultValue?: T): T {
    const resolvedKey = this.resolveExistingKey(key);
    if (resolvedKey === undefined) {
      const catalogDefault = getCoreSettingDefault(key) as T | undefined;
      return catalogDefault === undefined
        ? (defaultValue as T)
        : catalogDefault;
    }
    return this.values.get(resolvedKey) as T;
  }

  set(key: string, value: unknown): void {
    this.values.set(key, value);
    this.targets.set(key, 'workspace');
  }

  update<T>(
    key: string,
    value: T,
    target: ConfigTarget = 'workspace',
  ): Effect.Effect<void, ConfigWriteFailed> {
    return Effect.sync(() => {
      if (value === undefined) {
        this.values.delete(key);
        this.targets.delete(key);
      } else {
        this.values.set(key, value);
        this.targets.set(key, target);
      }
    });
  }

  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined {
    const resolvedKey = this.resolveExistingKey(key);
    if (resolvedKey === undefined) {
      return undefined;
    }
    const value = this.values.get(resolvedKey) as T;
    const target = this.targets.get(resolvedKey) ?? 'workspace';
    return {
      globalValue: target === 'global' ? value : undefined,
      workspaceValue: target === 'workspace' ? value : undefined,
    };
  }

  private resolveExistingKey(key: string): string | undefined {
    return this.configKeys(key).find((candidate) => this.values.has(candidate));
  }

  private configKeys(key: string): string[] {
    return key.startsWith('texra.') ? [key] : [key, `texra.${key}`];
  }
}

/**
 * `ConfigProvider` fake with real folder -> workspace -> global fallback,
 * mirroring the platform config providers' resolution order.
 * Unlike `FakeConfigProvider` above (which records one target per key and
 * so cannot hold a folder override and a global value for the same key at
 * once), this tracks the three scopes independently.
 *
 * `update()`'s `target` is intentionally never defaulted: a call site that
 * omits it is recorded as `undefined`, not silently coerced to
 * `'workspace'`, so tests can catch scope-mismatch regressions (issue
 * #7085) that a defaulted target would mask.
 */
export class FakeScopedConfigProvider implements ConfigProvider {
  private readonly globalValues = new Map<string, unknown>();

  private readonly workspaceValues = new Map<string, unknown>();

  private readonly workspaceFolderValues = new Map<string, unknown>();

  private readonly lastTargets = new Map<string, ConfigTarget>();

  readonly updateCalls: Array<{
    key: string;
    value: unknown;
    target: ConfigTarget | undefined;
  }> = [];

  /**
   * When set, `update()` calls targeting this scope throw instead of
   * applying -- simulates a persistence failure (e.g. VS Code rejecting the
   * write) so tests can assert on partial-migration recovery behavior.
   */
  failUpdatesForTarget?: ConfigTarget;

  get<T>(key: string, defaultValue?: T): T {
    if (this.workspaceFolderValues.has(key))
      return this.workspaceFolderValues.get(key) as T;
    if (this.workspaceValues.has(key))
      return this.workspaceValues.get(key) as T;
    if (this.globalValues.has(key)) return this.globalValues.get(key) as T;
    const catalogDefault = getCoreSettingDefault(key) as T | undefined;
    return catalogDefault === undefined ? (defaultValue as T) : catalogDefault;
  }

  update<T>(
    key: string,
    value: T,
    target?: ConfigTarget,
  ): Effect.Effect<void, ConfigWriteFailed> {
    if (target !== undefined && target === this.failUpdatesForTarget) {
      const message = `simulated ${target}-scope update failure for ${key}`;
      return Effect.fail(
        new ConfigWriteFailed({
          key,
          target,
          message,
          cause: new Error(message),
        }),
      );
    }
    return Effect.sync(() => {
      this.updateCalls.push({ key, value, target });
      if (target === undefined) {
        this.lastTargets.delete(key);
      } else {
        this.lastTargets.set(key, target);
      }
      const store =
        target === 'global' ? this.globalValues : this.workspaceValues;
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
    });
  }

  /** The most recent explicit `target` passed to `update()` for `key`, or `undefined` if none was given. */
  lastTargetFor(key: string): ConfigTarget | undefined {
    return this.lastTargets.get(key);
  }

  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined {
    return {
      globalValue: this.globalValues.has(key)
        ? (this.globalValues.get(key) as T)
        : undefined,
      workspaceValue: this.workspaceValues.has(key)
        ? (this.workspaceValues.get(key) as T)
        : undefined,
    };
  }

  /** Seeds a legacy global value directly, without going through `update()`. */
  seedGlobal(key: string, value: unknown): void {
    this.globalValues.set(key, value);
  }

  /** Seeds a workspace value directly, without going through `update()`. */
  seedWorkspace(key: string, value: unknown): void {
    this.workspaceValues.set(key, value);
  }

  /**
   * Seeds a resource-scoped `workspaceFolderValue` directly. Real writes to
   * the `'workspace'` target (`ConfigTarget` has no folder-scope option)
   * land in `workspaceValue`, but some settings are declared
   * `resource`-scoped, so UI writes to them commonly resolve as
   * `workspaceFolderValue` instead -- this seeds that shape directly.
   */
  seedWorkspaceFolder(key: string, value: unknown): void {
    this.workspaceFolderValues.set(key, value);
  }
}

export class FakeStateStore implements StateStore {
  private readonly values = new Map<string, unknown>();

  constructor(values: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(values)) {
      this.values.set(key, value);
    }
  }

  get<T>(key: string, defaultValue?: T): Effect.Effect<T> {
    return Effect.sync(() =>
      this.values.has(key) ? (this.values.get(key) as T) : (defaultValue as T),
    );
  }

  /**
   * A map write cannot fail, so the port's error channel stays empty.
   *
   * The write happens INSIDE the returned Effect, like the SQLite store.
   * A double that applied it eagerly would let a caller which awaits or
   * discards the effect look correct here while silently writing nothing
   * against the real store — the exact class this port's conversion exists to
   * expose.
   */
  update(key: string, value: unknown): Effect.Effect<void, StateWriteFailed> {
    return Effect.sync(() => {
      if (value === undefined) {
        this.values.delete(key);
      } else {
        this.values.set(key, value);
      }
    });
  }
}

export class FakeSecrets implements PlatformSecrets {
  private readonly values = new Map<string, string>();

  private readonly env: Record<string, string>;

  constructor(
    values: Record<string, string> = {},
    env: Record<string, string> = {},
  ) {
    for (const [key, value] of Object.entries(values)) {
      this.values.set(key, value);
    }
    this.env = env;
  }

  get(key: string): Effect.Effect<string | undefined, SecretsFailed> {
    return Effect.sync(() => this.values.get(key));
  }

  getStored(key: string): Effect.Effect<string | undefined, SecretsFailed> {
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

  getEnv(name: string): string | undefined {
    return this.env[name];
  }
}

/**
 * A detached pair of process stores, for a suite whose readers are all mocked
 * and only pass the bag through.
 */
export function fakeStores(): ModelOptionStores {
  return {
    secrets: new FakeSecrets(),
    config: new FakeConfigProvider(),
    workspaceState: new FakeStateStore(),
    globalState: new FakeStateStore(),
  };
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
  /** Conventional env-var fallbacks (e.g. `ANTHROPIC_API_KEY`) surfaced via `PlatformSecrets.getEnv`. */
  secretsEnv?: Record<string, string>;
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
}

/** The two process ports a fake host serves as `Lifecycle` and
 *  `AgentDirectories`, held per host because hosts change per test. */
export interface FakeProcessPorts {
  readonly lifecycle: LifecycleHost;
  readonly agentDirectories: AgentDirectoriesPort;
}

/**
 * Overrides for one fake host: the process ports above, the two
 * workspace-root ports a suite substitutes (a scoped config provider, a
 * hand-built state store), the process ports a root hands
 * `installProcessRuntime`, and the setup platform a setup-tool suite
 * provides. The workspace and storage paths come from `FakePlatformOptions`.
 */
export type FakeHostOverrides = Partial<FakeProcessPorts> &
  Partial<Pick<WorkspaceRoots, 'config' | 'workspaceState' | 'globalState'>> & {
    /** The store the host's `Secrets` service reads, as a root's own local. */
    readonly secrets?: PlatformSecrets;
    /** The two process ports, as `FakeHost` holds them. */
    readonly agentResume?: AgentResumePort;
    readonly languageModel?: LanguageModelPort;
    readonly setup?: SetupPlatformShape;
    /** The account plane the host's `SupabaseAuth` service reads. Absent hosts
     *  answer signed-out. */
    readonly auth?: SupabaseAuthShape;
  };

/** The workspace roots a fake host installs beside its platform. */
export function createFakeWorkspaceRoots(
  options: FakePlatformOptions = {},
  overrides: Partial<
    Pick<WorkspaceRoots, 'config' | 'workspaceState' | 'globalState'>
  > = {},
): WorkspaceRoots {
  return {
    workspace: Object.hasOwn(options, 'workspacePath')
      ? options.workspacePath
      : fakePath('workspace'),
    storage: options.storagePath ?? fakePath('workspace/.texra/storage'),
    globalStorage: options.globalStoragePath ?? fakeGlobalStorage(),
    config: overrides.config ?? new FakeConfigProvider(options.config),
    workspaceState:
      overrides.workspaceState ?? new FakeStateStore(options.workspaceState),
    globalState:
      overrides.globalState ?? new FakeStateStore(options.globalState),
  };
}

const FAKE_AGENT_DIRECTORIES: AgentDirectoriesPort = {
  custom: () => Effect.sync(() => fakePath('workspace/.texra/agents')),
  builtIn: () => Effect.sync(() => fakePath('workspace/resources/agents')),
  builtInToolUse: () =>
    Effect.sync(() => fakePath('workspace/resources/tool_use_agents')),
};

export function createFakePlatform(
  options: FakePlatformOptions = {},
  overrides: Partial<FakeProcessPorts> = {},
): FakeProcessPorts {
  seedFakeRoot(options.files ?? {});
  return {
    lifecycle: createLifecycleHost(),
    agentDirectories: FAKE_AGENT_DIRECTORIES,
    ...overrides,
  };
}
