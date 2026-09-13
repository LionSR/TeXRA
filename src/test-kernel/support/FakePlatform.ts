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

// Local imports
import type { ModelOptionStores } from '@model/computeModelOptions';
import {
  type ConfigInspection,
  type ConfigProvider,
  type ConfigTarget,
  type StateStore,
  type AgentDirectoriesPort,
} from '@platform/interfaces';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '@platform/languageModel';
import type { Platform } from '@platform/platform';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { getCoreSettingDefault } from '@shared/schemas';
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
 * The real directory every fake host's files live in: what `/` meant to the
 * in-memory filesystem this replaced. Emptied whenever a fake platform is
 * built, so a host starts from the files it seeds and nothing else.
 */
const FAKE_ROOT = path.join(workerTempHome(), 'root');

/**
 * A real path inside {@link FAKE_ROOT}. `fakePath('workspace/a.tex')` is the
 * path a `files` seed keyed `'/workspace/a.tex'` writes to, and is what a
 * suite asserting on an absolute path compares against.
 */
export function fakePath(...segments: string[]): string {
  return path.join(FAKE_ROOT, ...segments);
}

// A real directory: instance-presence sockets are genuine OS objects that
// live under the global storage root even when everything else is faked.
// Worker-shared so the thousands of per-test fake hosts that never touch
// presence do not each pay for a directory.
const FAKE_GLOBAL_STORAGE = path.join(workerTempHome(), 'global-storage');

mkdirSync(FAKE_ROOT, { recursive: true });
mkdirSync(FAKE_GLOBAL_STORAGE, { recursive: true });

/**
 * The real file a seed key names. Keys are paths inside {@link FAKE_ROOT}, so
 * `'/workspace/a.tex'` and `fakePath('workspace/a.tex')` name the same file:
 * the first is the spelling a suite writes by hand, the second the one a path
 * helper built on the installed roots produces.
 */
function seedTarget(key: string): string {
  if (key.startsWith(FAKE_ROOT)) return key;
  // Seed keys are paths inside the fake root ('/workspace/a.tex' and
  // fakePath('workspace/a.tex') name the same file). A real temp path built
  // outside this module would otherwise be nested under the root silently.
  const home = workerTempHome();
  const realTmp = realpathSync(os.tmpdir());
  if (
    key.startsWith(home) ||
    key.startsWith(realTmp) ||
    key.startsWith(os.tmpdir())
  ) {
    throw new Error(
      `Seed key ${key} is a real temp path; seed keys are paths inside the fake root (use fakePath).`,
    );
  }
  return fakePath(key);
}

/** Empties {@link FAKE_ROOT} and writes the seeded files into it. */
function seedFakeRoot(files: Record<string, string | Uint8Array>): void {
  rmSync(FAKE_ROOT, { recursive: true, force: true });
  mkdirSync(FAKE_ROOT, { recursive: true });
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

  async update<T>(
    key: string,
    value: T,
    target: ConfigTarget = 'workspace',
  ): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
      this.targets.delete(key);
    } else {
      this.values.set(key, value);
      this.targets.set(key, target);
    }
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

  isExplicitlySet(key: string): boolean {
    return this.resolveExistingKey(key) !== undefined;
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

  async update<T>(key: string, value: T, target?: ConfigTarget): Promise<void> {
    if (target !== undefined && target === this.failUpdatesForTarget) {
      throw new Error(`simulated ${target}-scope update failure for ${key}`);
    }
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

  isExplicitlySet(key: string): boolean {
    return (
      this.globalValues.has(key) ||
      this.workspaceValues.has(key) ||
      this.workspaceFolderValues.has(key)
    );
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

  get<T>(key: string, defaultValue?: T): T {
    if (!this.values.has(key)) {
      return defaultValue as T;
    }
    return this.values.get(key) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
      return;
    }
    this.values.set(key, value);
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

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async getStored(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async listStoredKeys(): Promise<readonly string[]> {
    return [...this.values.keys()];
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
  return { secrets: new FakeSecrets(), globalState: new FakeStateStore() };
}

export interface FakePlatformOptions {
  config?: Record<string, unknown>;
  globalState?: Record<string, unknown>;
  workspaceState?: Record<string, unknown>;
  /**
   * Files seeded into {@link FAKE_ROOT} before the host is installed. Keys
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

/**
 * Overrides for one fake host: the process platform's ports, the two
 * workspace-root ports a suite substitutes (a scoped config provider, a
 * hand-built state store), and the setup platform a setup-tool suite
 * provides. The workspace and storage paths come from `FakePlatformOptions`.
 */
export type FakeHostOverrides = Partial<Platform> &
  Partial<Pick<WorkspaceRoots, 'config' | 'workspaceState' | 'globalState'>> & {
    /** The store the host's `Secrets` service reads, as a root's own local. */
    readonly secrets?: PlatformSecrets;
    readonly setup?: SetupPlatformShape;
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
    globalStorage: options.globalStoragePath ?? FAKE_GLOBAL_STORAGE,
    config: overrides.config ?? new FakeConfigProvider(options.config),
    workspaceState:
      overrides.workspaceState ?? new FakeStateStore(options.workspaceState),
    globalState:
      overrides.globalState ?? new FakeStateStore(options.globalState),
  };
}

const FAKE_AGENT_DIRECTORIES: AgentDirectoriesPort = {
  custom: async () => fakePath('workspace/.texra/agents'),
  builtIn: async () => fakePath('workspace/resources/agents'),
  builtInToolUse: async () => fakePath('workspace/resources/tool_use_agents'),
};

export function createFakePlatform(
  options: FakePlatformOptions = {},
  overrides: Partial<Platform> = {},
): Platform {
  seedFakeRoot(options.files ?? {});
  return {
    fs: nodeFilesystem,
    lifecycle: createLifecycleHost(),
    agentResume: { tryResumeRun: async () => false },
    agentDirectories: FAKE_AGENT_DIRECTORIES,
    languageModel: UNAVAILABLE_LANGUAGE_MODEL_PORT,
    toolMissingHandler: () => {},
    ...overrides,
  };
}
