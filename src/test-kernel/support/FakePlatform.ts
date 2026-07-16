// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { createFsFromVolume, Volume, type IFs } from 'memfs';

// Local imports - platform
import {
  FileType,
  NO_TOOL_AVAILABILITY_HOST,
  type FileStat,
  type FileSystemProvider,
  type ConfigInspection,
  type ConfigProvider,
  type ConfigTarget,
  type Disposable,
  type StateStore,
  type StorageProvider,
  type WorkspaceProvider,
  type AgentDirectoriesPort,
} from '@platform/interfaces';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '@platform/languageModel';
import type { Platform } from '@platform/platform';
import type { PlatformSecrets } from '@platform/secrets';

function fakeFsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function normalizePath(target: string): string {
  return path.posix.resolve('/', target.replaceAll('\\', '/'));
}

function relativeChildPath(
  parent: string,
  candidate: string,
): string | undefined {
  const relative = path.posix.relative(parent, candidate);
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.posix.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative;
}

function hasChildPath(parent: string, candidate: string): boolean {
  return relativeChildPath(parent, candidate) !== undefined;
}

type FileTypeProbe = {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
};

type DirectoryEntryProbe = FileTypeProbe & { name: string };

async function resolveSymlinkType(fs: IFs, target: string): Promise<number> {
  let targetType: number = FileType.Unknown;
  try {
    const stats = await fs.promises.stat(target);
    if (stats.isFile()) targetType = FileType.File;
    else if (stats.isDirectory()) targetType = FileType.Directory;
  } catch {
    // Dangling symlink: preserve the symlink bit with an unknown target type.
  }
  return FileType.SymbolicLink | targetType;
}

async function fileTypeFor(
  fs: IFs,
  entry: FileTypeProbe,
  target: string,
): Promise<number> {
  if (entry.isSymbolicLink()) return resolveSymlinkType(fs, target);
  if (entry.isFile()) return FileType.File;
  if (entry.isDirectory()) return FileType.Directory;
  return FileType.Unknown;
}

export class FakeConfigProvider implements ConfigProvider {
  private readonly values = new Map<string, unknown>();

  private readonly targets = new Map<string, ConfigTarget>();

  private readonly watchers = new Set<{
    key: string | readonly string[] | RegExp;
    listener: () => void;
  }>();

  constructor(values: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(values)) {
      this.values.set(key, value);
      this.targets.set(key, 'workspace');
    }
  }

  get<T>(key: string, defaultValue?: T): T {
    const resolvedKey = this.resolveExistingKey(key);
    if (resolvedKey === undefined) {
      return defaultValue as T;
    }
    return this.values.get(resolvedKey) as T;
  }

  set(key: string, value: unknown): void {
    this.values.set(key, value);
    this.targets.set(key, 'workspace');
    this.notifyWatchers(key);
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
    this.notifyWatchers(key);
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
      effectiveValue: value,
    };
  }

  isExplicitlySet(key: string): boolean {
    return this.resolveExistingKey(key) !== undefined;
  }

  watch(
    key: string | readonly string[] | RegExp,
    listener: () => void,
  ): Disposable {
    const watcher = { key, listener };
    this.watchers.add(watcher);
    return {
      dispose: () => {
        this.watchers.delete(watcher);
      },
    };
  }

  private notifyWatchers(changedKey: string): void {
    for (const watcher of this.watchers) {
      if (this.matchesWatchedKey(watcher.key, changedKey)) {
        watcher.listener();
      }
    }
  }

  private matchesWatchedKey(
    watchedKey: string | readonly string[] | RegExp,
    changedKey: string,
  ): boolean {
    if (watchedKey instanceof RegExp) {
      // Match VscodeConfigProvider: VS Code does not expose changed keys for
      // regex watchers, so regex subscriptions conservatively refresh.
      return true;
    }
    if (typeof watchedKey === 'string') {
      return this.affectsConfiguration(watchedKey, changedKey);
    }
    return watchedKey.some((key) => this.affectsConfiguration(key, changedKey));
  }

  private resolveExistingKey(key: string): string | undefined {
    return this.configKeys(key).find((candidate) => this.values.has(candidate));
  }

  private configKeys(key: string): string[] {
    return key.startsWith('texra.') ? [key] : [key, `texra.${key}`];
  }

  private affectsConfiguration(
    watchedKey: string,
    changedKey: string,
  ): boolean {
    return this.configKeys(watchedKey).some((watchedCandidate) =>
      this.isSameOrNestedKey(watchedCandidate, changedKey),
    );
  }

  private isSameOrNestedKey(first: string, second: string): boolean {
    return (
      first === second ||
      first.startsWith(`${second}.`) ||
      second.startsWith(`${first}.`)
    );
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

export class FakeFileSystemProvider implements FileSystemProvider {
  private readonly fs: IFs;

  constructor(files: Record<string, string | Uint8Array> = {}) {
    this.fs = createFsFromVolume(new Volume());
    this.fs.mkdirSync('/', { recursive: true });
    for (const [target, content] of Object.entries(files)) {
      this.setFile(target, content);
    }
  }

  async stat(target: string): Promise<FileStat> {
    const normalized = normalizePath(target);
    const lstats = await this.fs.promises.lstat(normalized);
    const type = await fileTypeFor(this.fs, lstats, normalized);
    const stats = lstats.isSymbolicLink()
      ? await this.fs.promises.stat(normalized).catch(() => lstats)
      : lstats;
    return {
      type,
      ctime: Number(stats.ctimeMs),
      mtime: Number(stats.mtimeMs),
      size: Number(stats.size),
    };
  }

  async isSymlink(target: string): Promise<boolean> {
    const stats = await this.fs.promises.lstat(normalizePath(target));
    return stats.isSymbolicLink();
  }

  async realPath(target: string): Promise<string> {
    const resolved = await this.fs.promises.realpath(normalizePath(target));
    return resolved.toString();
  }

  async readFile(target: string): Promise<Uint8Array> {
    const content = await this.fs.promises.readFile(normalizePath(target));
    return typeof content === 'string' ? Buffer.from(content) : content;
  }

  async readFileChunk(
    target: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const content = await this.readFile(target);
    return content.subarray(offset, offset + length);
  }

  async writeFile(target: string, content: Uint8Array): Promise<void> {
    await this.fs.promises.writeFile(
      normalizePath(target),
      Buffer.from(content),
    );
  }

  async writeFileAtomic(target: string, content: Uint8Array): Promise<void> {
    // In-memory: the temp+rename of a real atomic write has no observable
    // intermediate state here, so a direct write is equivalent.
    await this.writeFile(target, content);
  }

  async appendFile(target: string, content: Uint8Array): Promise<void> {
    await this.fs.promises.appendFile(
      normalizePath(target),
      Buffer.from(content),
    );
  }

  async delete(
    target: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const normalized = normalizePath(target);
    if (normalized === '/') {
      throw fakeFsError('EPERM', 'Cannot delete filesystem root');
    }
    await this.fs.promises.rm(normalized, {
      recursive: options?.recursive ?? false,
      force: true,
    });
  }

  async createDirectory(target: string): Promise<void> {
    await this.fs.promises.mkdir(normalizePath(target), { recursive: true });
  }

  async readDirectory(target: string): Promise<[string, number][]> {
    const normalized = normalizePath(target);
    const entries = await this.fs.promises.readdir(normalized, {
      withFileTypes: true,
    });
    const dirents = entries as DirectoryEntryProbe[];
    const resolved = await Promise.all(
      dirents.map(async (entry) => {
        const type = await fileTypeFor(
          this.fs,
          entry,
          path.posix.join(normalized, entry.name),
        );
        return [entry.name, type] as [string, number];
      }),
    );
    return resolved.toSorted(([left], [right]) => left.localeCompare(right));
  }

  async copy(
    source: string,
    dest: string,
    options?: { overwrite?: boolean; dereference?: boolean },
  ): Promise<void> {
    const normalizedSource = normalizePath(source);
    const normalizedDest = normalizePath(dest);
    const sourceStats = await this.fs.promises.stat(normalizedSource);
    if (sourceStats.isDirectory()) {
      if (normalizedSource === normalizedDest) {
        throw fakeFsError(
          'ERR_FS_CP_EINVAL',
          `Cannot copy a path onto itself: ${source} -> ${dest}`,
        );
      }
      if (hasChildPath(normalizedSource, normalizedDest)) {
        throw fakeFsError(
          'ERR_FS_CP_EINVAL',
          `Cannot copy a directory into itself: ${source} -> ${dest}`,
        );
      }
      await this.fs.promises.cp(normalizedSource, normalizedDest, {
        recursive: true,
        force: options?.overwrite ?? false,
        errorOnExist: !(options?.overwrite ?? false),
        dereference: options?.dereference ?? false,
      });
      return;
    }

    const flag = options?.overwrite ? 0 : this.fs.constants.COPYFILE_EXCL;
    await this.fs.promises.copyFile(normalizedSource, normalizedDest, flag);
  }

  async rename(
    source: string,
    dest: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    const normalizedSource = normalizePath(source);
    const normalizedDest = normalizePath(dest);
    if (!options?.overwrite) {
      try {
        await this.fs.promises.lstat(normalizedDest);
        throw fakeFsError('EEXIST', `Target already exists: ${dest}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    const sourceStats = await this.fs.promises.lstat(normalizedSource);
    if (
      sourceStats.isDirectory() &&
      hasChildPath(normalizedSource, normalizedDest)
    ) {
      throw fakeFsError(
        'EINVAL',
        `Cannot rename a directory into itself: ${source} -> ${dest}`,
      );
    }
    await this.fs.promises.rename(normalizedSource, normalizedDest);
  }

  exists(target: string): boolean {
    return this.fs.existsSync(normalizePath(target));
  }

  setFile(target: string, content: string | Uint8Array): void {
    const normalized = normalizePath(target);
    this.fs.mkdirSync(path.posix.dirname(normalized), { recursive: true });
    this.fs.writeFileSync(normalized, Buffer.from(stringToBytes(content)));
  }

  getText(target: string): string {
    const content = this.fs.readFileSync(normalizePath(target));
    return typeof content === 'string' ? content : content.toString('utf8');
  }
}

class FakeWorkspaceProvider implements WorkspaceProvider {
  constructor(private readonly workspacePath: string | undefined) {}

  getWorkspacePath(): string | undefined {
    return this.workspacePath;
  }

  asRelativePath(filePath: string): string {
    if (!this.workspacePath) {
      return filePath;
    }
    const workspacePath = normalizePath(this.workspacePath);
    const normalized = normalizePath(filePath);
    const relative = path.posix.relative(workspacePath, normalized);
    if (relative.startsWith('..') || path.posix.isAbsolute(relative)) {
      return filePath;
    }
    return relative.replaceAll('\\', '/');
  }
}

class FakeStorageProvider implements StorageProvider {
  constructor(
    private readonly storagePath = '/workspace/.texra/storage',
    private readonly globalStoragePath = '/global/.texra/storage',
  ) {}

  getStoragePath(): string {
    return this.storagePath;
  }

  getGlobalStoragePath(): string {
    return this.globalStoragePath;
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

export interface FakePlatformOptions {
  config?: Record<string, unknown>;
  globalState?: Record<string, unknown>;
  workspaceState?: Record<string, unknown>;
  files?: Record<string, string | Uint8Array>;
  secrets?: Record<string, string>;
  /** Conventional env-var fallbacks (e.g. `ANTHROPIC_API_KEY`) surfaced via `PlatformSecrets.getEnv`. */
  secretsEnv?: Record<string, string>;
  workspacePath?: string | undefined;
  storagePath?: string;
  globalStoragePath?: string;
}

const FAKE_AGENT_DIRECTORIES: AgentDirectoriesPort = {
  custom: async () => '/workspace/.texra/agents',
  builtIn: async () => '/workspace/resources/agents',
  builtInToolUse: async () => '/workspace/resources/tool_use_agents',
};

export function createFakePlatform(
  options: FakePlatformOptions = {},
  overrides: Partial<Platform> = {},
): Platform {
  const workspacePath = Object.hasOwn(options, 'workspacePath')
    ? options.workspacePath
    : '/workspace';

  return {
    config: new FakeConfigProvider(options.config),
    globalState: new FakeStateStore(options.globalState),
    workspaceState: new FakeStateStore(options.workspaceState),
    fs: new FakeFileSystemProvider(options.files),
    workspace: new FakeWorkspaceProvider(workspacePath),
    storage: new FakeStorageProvider(
      options.storagePath,
      options.globalStoragePath,
    ),
    secrets: new FakeSecrets(options.secrets, options.secretsEnv),
    lifecycle: createLifecycleHost(),
    agentResume: { tryResumeStream: async () => false },
    agentDirectories: FAKE_AGENT_DIRECTORIES,
    languageModel: UNAVAILABLE_LANGUAGE_MODEL_PORT,
    toolAvailability: NO_TOOL_AVAILABILITY_HOST,
    toolMissingHandler: () => {},
    ...overrides,
  };
}

function stringToBytes(content: string | Uint8Array): Uint8Array {
  if (typeof content === 'string') {
    return Buffer.from(content, 'utf8');
  }
  return content;
}
