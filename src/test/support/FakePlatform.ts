// Standard library imports
import * as path from 'path';

// Local imports - platform
import {
  FileType,
  type FileStat,
  type FileSystemProvider,
} from '@platform/interfaces/filesystem';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import type {
  ConfigInspection,
  ConfigProvider,
  ConfigTarget,
} from '@platform/interfaces/config';
import type { Disposable } from '@platform/interfaces/disposable';
import type { StateStore } from '@platform/interfaces/state';
import type { StorageProvider } from '@platform/interfaces/storage';
import type { WorkspaceProvider } from '@platform/interfaces/workspace';
import type { Platform } from '@platform/platform';
import type { PlatformSecrets } from '@platform/secrets';

type FakeFileRecord =
  | {
      type: typeof FileType.Directory;
      ctime: number;
      mtime: number;
    }
  | {
      type: typeof FileType.File;
      ctime: number;
      mtime: number;
      content: Uint8Array;
    };

export type RecordingLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RecordingLogEntry {
  level: RecordingLogLevel;
  message: string;
}

function fakeFsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function now(): number {
  return Date.now();
}

function cloneBytes(content: Uint8Array): Uint8Array {
  return new Uint8Array(content);
}

function normalizePath(target: string): string {
  return path.posix.resolve('/', target.replaceAll('\\', '/'));
}

function parentPath(target: string): string {
  return path.posix.dirname(normalizePath(target));
}

function hasChildPath(parent: string, candidate: string): boolean {
  const relative = path.posix.relative(parent, candidate);
  return (
    relative !== '' &&
    !relative.startsWith('..') &&
    !path.posix.isAbsolute(relative)
  );
}

function directChildName(
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
  return relative.split(path.posix.sep).at(0);
}

function fileSize(record: FakeFileRecord): number {
  return record.type === FileType.File ? record.content.byteLength : 0;
}

function fileStat(record: FakeFileRecord): FileStat {
  return {
    type: record.type,
    ctime: record.ctime,
    mtime: record.mtime,
    size: fileSize(record),
  };
}

function cloneRecord(record: FakeFileRecord): FakeFileRecord {
  if (record.type === FileType.File) {
    return {
      ...record,
      content: cloneBytes(record.content),
    };
  }
  return { ...record };
}

function copyRecord(record: FakeFileRecord): FakeFileRecord {
  const timestamp = now();
  if (record.type === FileType.File) {
    return {
      type: FileType.File,
      ctime: timestamp,
      mtime: timestamp,
      content: cloneBytes(record.content),
    };
  }
  return {
    type: FileType.Directory,
    ctime: timestamp,
    mtime: timestamp,
  };
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
  private readonly records = new Map<string, FakeFileRecord>();

  constructor(files: Record<string, string | Uint8Array> = {}) {
    this.createDirectorySync('/');
    for (const [target, content] of Object.entries(files)) {
      this.setFile(target, content);
    }
  }

  async stat(target: string): Promise<FileStat> {
    return fileStat(this.requireRecord(target));
  }

  async realPath(target: string): Promise<string> {
    this.requireRecord(target);
    return normalizePath(target);
  }

  async readFile(target: string): Promise<Uint8Array> {
    const record = this.requireRecord(target);
    if (record.type !== FileType.File) {
      throw fakeFsError('EISDIR', `Path is a directory: ${target}`);
    }
    return cloneBytes(record.content);
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
    this.writeFileSync(target, content, { overwrite: true });
  }

  async delete(
    target: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const normalized = normalizePath(target);
    if (normalized === '/') {
      throw fakeFsError('EPERM', 'Cannot delete filesystem root');
    }
    const record = this.records.get(normalized);
    if (!record) {
      return;
    }

    if (record.type === FileType.File) {
      this.records.delete(normalized);
      return;
    }

    const children = this.childPaths(normalized);
    if (children.length > 0 && !options?.recursive) {
      throw fakeFsError('ENOTEMPTY', `Directory is not empty: ${target}`);
    }
    for (const child of children) {
      this.records.delete(child);
    }
    if (normalized !== '/') {
      this.records.delete(normalized);
    }
  }

  async createDirectory(target: string): Promise<void> {
    this.createDirectorySync(target);
  }

  async readDirectory(target: string): Promise<[string, number][]> {
    const normalized = normalizePath(target);
    const record = this.requireRecord(normalized);
    if (record.type !== FileType.Directory) {
      throw fakeFsError('ENOTDIR', `Path is not a directory: ${target}`);
    }

    const entries = new Map<string, number>();
    for (const candidate of this.records.keys()) {
      const name = directChildName(normalized, candidate);
      if (name == null) continue;
      const childPath = path.posix.join(normalized, name);
      const childRecord = this.records.get(childPath);
      entries.set(name, childRecord?.type ?? FileType.Directory);
    }
    return [...entries.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
  }

  async copy(
    source: string,
    dest: string,
    options?: { overwrite?: boolean; dereference?: boolean },
  ): Promise<void> {
    const normalizedSource = normalizePath(source);
    const normalizedDest = normalizePath(dest);
    const sourceRecord = this.requireRecord(normalizedSource);
    if (normalizedSource === normalizedDest) {
      throw fakeFsError(
        'EINVAL',
        sourceRecord.type === FileType.Directory
          ? `Cannot copy a directory onto itself: ${source} -> ${dest}`
          : `Cannot copy a file onto itself: ${source} -> ${dest}`,
      );
    }

    if (sourceRecord.type === FileType.File) {
      this.assertWritableTarget(normalizedDest, options?.overwrite);
      this.writeFileSync(normalizedDest, sourceRecord.content, {
        overwrite: options?.overwrite,
      });
      return;
    }

    this.assertNotSelfDescendant(normalizedSource, normalizedDest, 'copy');
    this.assertDirectoryCopyRootTarget(normalizedDest);
    this.createDirectorySync(normalizedDest);
    for (const child of this.childPaths(normalizedSource)) {
      const relative = path.posix.relative(normalizedSource, child);
      const childDest = path.posix.join(normalizedDest, relative);
      const childRecord = this.requireRecord(child);
      this.assertDirectoryCopyChildTarget(
        childDest,
        childRecord,
        options?.overwrite,
      );
      this.records.set(childDest, copyRecord(childRecord));
    }
  }

  async rename(
    source: string,
    dest: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    const normalizedSource = normalizePath(source);
    const normalizedDest = normalizePath(dest);
    const sourceRecord = this.requireRecord(normalizedSource);
    if (normalizedSource === normalizedDest) {
      return;
    }

    this.assertWritableTarget(normalizedDest, options?.overwrite);

    if (sourceRecord.type === FileType.File) {
      const existing = this.records.get(normalizedDest);
      if (existing?.type === FileType.Directory) {
        throw fakeFsError('EISDIR', `Path is a directory: ${dest}`);
      }
      this.assertParentDirectoryExists(normalizedDest);
      this.records.set(normalizedDest, cloneRecord(sourceRecord));
      this.records.delete(normalizedSource);
      return;
    }

    this.assertNotSelfDescendant(normalizedSource, normalizedDest, 'rename');
    this.assertDirectoryRenameTarget(normalizedDest);
    this.assertParentDirectoryExists(normalizedDest);
    this.createDirectorySync(normalizedDest);
    for (const child of this.childPaths(normalizedSource)) {
      const relative = path.posix.relative(normalizedSource, child);
      const childDest = path.posix.join(normalizedDest, relative);
      this.records.set(childDest, cloneRecord(this.requireRecord(child)));
    }
    await this.delete(normalizedSource, { recursive: true });
  }

  exists(target: string): boolean {
    return this.records.has(normalizePath(target));
  }

  setFile(target: string, content: string | Uint8Array): void {
    this.writeFileSync(target, stringToBytes(content), {
      createParent: true,
      overwrite: true,
    });
  }

  getText(target: string): string {
    return Buffer.from(this.requireFile(target).content).toString('utf8');
  }

  private requireRecord(target: string): FakeFileRecord {
    const normalized = normalizePath(target);
    const record = this.records.get(normalized);
    if (!record) {
      throw fakeFsError('ENOENT', `File not found: ${target}`);
    }
    return record;
  }

  private requireFile(
    target: string,
  ): Extract<FakeFileRecord, { content: Uint8Array }> {
    const record = this.requireRecord(target);
    if (record.type !== FileType.File) {
      throw fakeFsError('EISDIR', `Path is a directory: ${target}`);
    }
    return record;
  }

  private writeFileSync(
    target: string,
    content: Uint8Array,
    options: { createParent?: boolean; overwrite?: boolean } = {},
  ): void {
    const normalized = normalizePath(target);
    const existing = this.records.get(normalized);
    if (existing?.type === FileType.Directory) {
      throw fakeFsError('EISDIR', `Path is a directory: ${target}`);
    }
    if (existing && !options.overwrite) {
      throw fakeFsError('EEXIST', `Target already exists: ${target}`);
    }

    const parent = parentPath(normalized);
    if (options.createParent) {
      this.createDirectorySync(parent);
    } else {
      const parentRecord = this.records.get(parent);
      if (!parentRecord) {
        throw fakeFsError('ENOENT', `Parent directory not found: ${parent}`);
      }
      if (parentRecord.type !== FileType.Directory) {
        throw fakeFsError(
          'ENOTDIR',
          `Parent path is not a directory: ${parent}`,
        );
      }
    }

    const timestamp = now();
    this.records.set(normalized, {
      type: FileType.File,
      ctime: timestamp,
      mtime: timestamp,
      content: cloneBytes(content),
    });
  }

  private createDirectorySync(target: string): void {
    const normalized = normalizePath(target);
    const existing = this.records.get(normalized);
    if (existing?.type === FileType.File) {
      throw fakeFsError('ENOTDIR', `Path is a file: ${target}`);
    }

    const parts = normalized.split(path.posix.sep).filter(Boolean);
    let current: string = path.posix.sep;
    this.ensureDirectoryRecord(current);
    for (const part of parts) {
      current = path.posix.join(current, part);
      this.ensureDirectoryRecord(current);
    }
  }

  private ensureDirectoryRecord(target: string): void {
    const existing = this.records.get(target);
    if (existing?.type === FileType.File) {
      throw fakeFsError('ENOTDIR', `Path is a file: ${target}`);
    }
    if (!existing) {
      const timestamp = now();
      this.records.set(target, {
        type: FileType.Directory,
        ctime: timestamp,
        mtime: timestamp,
      });
    }
  }

  private childPaths(parent: string): string[] {
    return [...this.records.keys()].filter((candidate) =>
      hasChildPath(parent, candidate),
    );
  }

  private assertWritableTarget(target: string, overwrite?: boolean): void {
    if (!overwrite && this.records.has(target)) {
      throw fakeFsError('EEXIST', `Target already exists: ${target}`);
    }
  }

  private assertNotSelfDescendant(
    source: string,
    dest: string,
    operation: string,
  ): void {
    if (hasChildPath(source, dest)) {
      throw fakeFsError(
        'EINVAL',
        `Cannot ${operation} a directory into itself: ${source} -> ${dest}`,
      );
    }
  }

  private assertDirectoryRenameTarget(dest: string): void {
    const destRecord = this.records.get(dest);
    if (destRecord?.type === FileType.File) {
      throw fakeFsError('ENOTDIR', `Path is a file: ${dest}`);
    }
    if (
      destRecord?.type === FileType.Directory &&
      this.childPaths(dest).length > 0
    ) {
      throw fakeFsError('ENOTEMPTY', `Directory is not empty: ${dest}`);
    }
  }

  private assertDirectoryCopyRootTarget(dest: string): void {
    const destRecord = this.records.get(dest);
    if (destRecord?.type === FileType.File) {
      throw fakeFsError('ENOTDIR', `Path is a file: ${dest}`);
    }
  }

  private assertDirectoryCopyChildTarget(
    dest: string,
    sourceRecord: FakeFileRecord,
    overwrite?: boolean,
  ): void {
    const destRecord = this.records.get(dest);
    if (!destRecord) {
      return;
    }
    if (destRecord.type === sourceRecord.type) {
      if (sourceRecord.type === FileType.File && !overwrite) {
        throw fakeFsError('EEXIST', `Target already exists: ${dest}`);
      }
      return;
    }
    if (destRecord.type === FileType.Directory) {
      throw fakeFsError('EISDIR', `Path is a directory: ${dest}`);
    }
    throw fakeFsError('ENOTDIR', `Path is a file: ${dest}`);
  }

  private assertParentDirectoryExists(target: string): void {
    const parent = parentPath(target);
    const parentRecord = this.records.get(parent);
    if (!parentRecord) {
      throw fakeFsError('ENOENT', `Parent directory not found: ${parent}`);
    }
    if (parentRecord.type !== FileType.Directory) {
      throw fakeFsError('ENOTDIR', `Parent path is not a directory: ${parent}`);
    }
  }
}

export class FakeWorkspaceProvider implements WorkspaceProvider {
  private readonly watchers = new Set<{
    globPattern: string;
    listener: () => void;
  }>();

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

  watch(globPattern: string, listener: () => void): Disposable {
    const watcher = { globPattern, listener };
    this.watchers.add(watcher);
    return {
      dispose: () => {
        this.watchers.delete(watcher);
      },
    };
  }
}

export class FakeStorageProvider implements StorageProvider {
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

  constructor(values: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(values)) {
      this.values.set(key, value);
    }
  }

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export interface FakePlatformOptions {
  config?: Record<string, unknown>;
  globalState?: Record<string, unknown>;
  workspaceState?: Record<string, unknown>;
  files?: Record<string, string | Uint8Array>;
  secrets?: Record<string, string>;
  workspacePath?: string | undefined;
  storagePath?: string;
  globalStoragePath?: string;
}

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
    secrets: new FakeSecrets(options.secrets),
    lifecycle: createLifecycleHost(),
    agentResume: { tryResumeStream: async () => false },
    ...overrides,
  };
}

function stringToBytes(content: string | Uint8Array): Uint8Array {
  if (typeof content === 'string') {
    return Buffer.from(content, 'utf8');
  }
  return content;
}
