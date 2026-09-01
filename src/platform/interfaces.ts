/**
 * Platform port contracts — the host-neutral interfaces a host wires into
 * `initPlatform()`. Formerly one file per port under `interfaces/`.
 *
 * This file is compiled under every host's tsconfig, including projects
 * (e.g. the desktop renderer) that carry no Node type definitions — so it
 * must never reference `node:fs` or the ambient `NodeJS` namespace, even for
 * members only a Node-backed implementation can honor.
 */
import type { StreamTabId } from '@shared/schemas';

// ---------------------------------------------------------------------------
// Disposable
// ---------------------------------------------------------------------------

/**
 * Host-neutral disposable resource.
 *
 * Structurally compatible with VS Code's Disposable and the unsubscribe
 * callbacks used by Electron-side adapters.
 */
export interface Disposable {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type ConfigTarget = 'global' | 'workspace';

export interface ConfigInspection<T = unknown> {
  globalValue?: T;
  workspaceValue?: T;
}

/**
 * Platform configuration provider interface.
 */
export interface ConfigProvider {
  /**
   * Resolution order an implementation must honor: stored workspace value,
   * stored global value, the setting catalog's own default
   * (`getCoreSettingDefault`), and only then the caller's `defaultValue`.
   * Callers of a cataloged `texra.*` key therefore omit `defaultValue`; it is
   * for keys the catalog does not own.
   */
  get<T>(key: string, defaultValue?: T): T;
  update<T>(key: string, value: T, target?: ConfigTarget): Promise<void>;
  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined;
  isExplicitlySet(key: string): boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Platform key-value state store interface.
 * Matches the vscode.Memento surface for compatibility.
 */
export interface StateStore {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/**
 * Platform filesystem provider interface.
 *
 * All paths are absolute strings. Implementations convert to
 * platform-specific representations (e.g. vscode.Uri) internally.
 */

/**
 * File type enum (bitmask-compatible with vscode.FileType).
 */
export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
} as const;

export type FileType = (typeof FileType)[keyof typeof FileType];

/**
 * File stat result (matches vscode.FileStat shape).
 */
export interface FileStat {
  type: number;
  ctime: number;
  mtime: number;
  size: number;
}

export interface FileSystemProvider {
  stat(path: string): Promise<FileStat>;
  /**
   * Returns true when `path` is a symbolic link (does NOT follow the link).
   * Prefer this over checking the `SymbolicLink` bit from `readDirectory`
   * entries; some `vscode.workspace.fs` implementations do not set that bit.
   */
  isSymlink(path: string): Promise<boolean>;
  realPath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  /**
   * Crash-safe write: stage to a temp file and atomically rename over the
   * target so a torn/partial file is never observable after an unclean exit.
   * Used for durable run/flow state; plain `writeFile` remains for workspace
   * files (where atomic rename would replace a user's symlink).
   */
  writeFileAtomic(path: string, content: Uint8Array): Promise<void>;
  /**
   * Make `path` appear complete and durable in one step: stage the content
   * beside it, fsync, then rename into place. For names that belong to
   * exactly one writer (an execution-lease claim), where `writeFileAtomic`'s
   * replace-existing semantics are not wanted and a torn file must never be
   * observable.
   */
  publishFile(path: string, content: Uint8Array): Promise<void>;
  /** Remove a directory only if it is empty; rejects with `ENOTEMPTY`. */
  removeEmptyDirectory(path: string): Promise<void>;
  appendFile(path: string, content: Uint8Array): Promise<void>;
  delete(path: string, options?: { recursive?: boolean }): Promise<void>;
  createDirectory(path: string): Promise<void>;
  readDirectory(path: string): Promise<[string, number][]>;
  copy(
    source: string,
    dest: string,
    options?: { overwrite?: boolean; dereference?: boolean },
  ): Promise<void>;
  rename(
    source: string,
    dest: string,
    options?: { overwrite?: boolean },
  ): Promise<void>;

  // --- Sync and stream operations -----------------------------------------
  // No cross-host abstraction exists for these (a synchronous call or a byte
  // stream has no vscode.workspace.fs or browser equivalent), so only a
  // Node-backed implementation can honor them. Every FileSystemProvider still
  // implements them so callers reach the disk only through this port, never
  // by importing node:fs themselves; the stream shapes below are kept
  // deliberately minimal (see file header) rather than the real node:fs
  // types, and a Node-backed implementation's actual return value is a real
  // `fs.ReadStream`/`fs.WriteStream`, a structural subtype of these.
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
  deleteSync(path: string): void;
  createDirectorySync(path: string, options?: { recursive?: boolean }): void;
  statSync(path: string): FileStat;
  createReadStream(
    path: string,
    options?: ReadStreamOptions,
  ): AsyncIterable<Uint8Array> & { destroy(error?: Error): void };
  createWriteStream(
    path: string,
    options?: WriteStreamOptions,
  ): { end(): void };
}

export interface ReadStreamOptions {
  flags?: string;
  encoding?: string;
  fd?: number;
  mode?: number;
  autoClose?: boolean;
  start?: number;
  end?: number;
  highWaterMark?: number;
}

export interface WriteStreamOptions {
  flags?: string;
  encoding?: string;
  fd?: number;
  mode?: number;
  autoClose?: boolean;
  start?: number;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/**
 * Platform workspace provider interface.
 */
export interface WorkspaceProvider {
  /** The canonical physical workspace root, or undefined if none is open. */
  getWorkspacePath(): string | undefined;

  /**
   * Convert an absolute path to a workspace-relative path.
   * Should be symlink-aware where possible.
   * Returns the original path if it is outside the workspace.
   */
  asRelativePath(filePath: string): string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Platform storage path provider interface.
 */
export interface StorageProvider {
  /** Per-workspace storage root path. */
  getStoragePath(): string;

  /** Cross-workspace global storage root path. */
  getGlobalStoragePath(): string;
}

// ---------------------------------------------------------------------------
// Process liveness
// ---------------------------------------------------------------------------

/**
 * Kernel facts about processes, used to prove whether the owner recorded in
 * an execution lease is still the same process. An identity is an opaque
 * string that cannot change while a process runs and that no later process
 * with the same pid can repeat: two equal strings name one process, two
 * different strings name two. Its format is the port's business; callers
 * only compare it verbatim.
 */
export interface ProcessesPort {
  /** Start identity of `pid`, or undefined when it cannot be read. */
  identity(pid: number): Promise<string | undefined>;
  /** This process's own identity; memoized once read, retried until then. */
  selfIdentity(): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Cross-process file locks
// ---------------------------------------------------------------------------

/** Serialize work by a canonical absolute path shared by every host process. */
export interface FileLockProvider {
  runExclusive<T>(path: string, operation: () => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const SHUTDOWN_PHASE = {
  BEFORE: 'beforeShutdown',
  ON: 'onShutdown',
} as const;

export type ShutdownPhase =
  (typeof SHUTDOWN_PHASE)[keyof typeof SHUTDOWN_PHASE];

export interface LifecycleHost {
  /**
   * Register a shutdown handler. `signal` fires at the phase's
   * join-with-deadline: a handler that can be safely cut short should race it
   * and settle; the drain aborts-then-advances past any handler that has not
   * settled shortly after the deadline.
   */
  onShutdown(
    phase: ShutdownPhase,
    callback: (signal: AbortSignal) => void | Promise<void>,
  ): Disposable;
  runShutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tool availability
// ---------------------------------------------------------------------------

/**
 * Host-owned availability checks for integrations that cannot be detected from
 * host-agnostic core code alone.
 */
export interface ToolAvailabilityHost {
  /** True when a VS Code extension is installed in the active extension host. */
  isVscodeExtensionInstalled(extensionId: string): boolean;

  /** True when the current process already is the TeXRA CLI entrypoint. */
  isTexraCliEntrypoint(): boolean;
}

export const NO_TOOL_AVAILABILITY_HOST: ToolAvailabilityHost = Object.freeze({
  isVscodeExtensionInstalled: () => false,
  isTexraCliEntrypoint: () => false,
});

// ---------------------------------------------------------------------------
// Tool notifications
// ---------------------------------------------------------------------------

/**
 * Pluggable handler for surfacing tool-missing errors to the user. Hosts
 * without a UI for this (CLI, desktop) no-op.
 */
export type ToolMissingHandler = (
  message: string,
  openDocsCommand?: string,
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Agent directories
// ---------------------------------------------------------------------------

/** Host-provided agent directory paths. */
export interface AgentDirectoriesPort {
  custom(): Promise<string>;
  builtIn(): Promise<string>;
  builtInToolUse(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Agent resume
// ---------------------------------------------------------------------------

/**
 * Host capability for resuming an agent stream from its persisted snapshot.
 *
 * Implemented by the VS Code host (and any other host) so VS Code-free code
 * (e.g. the inquiry continuation injector) can trigger auto-resume without
 * importing the host-level command pipeline.
 */
export interface RecoveryContinuation {
  readonly streamId: StreamTabId;
  readonly kind: 'recovery';
}

export interface AgentResumePort {
  /**
   * Attempt to resume a WAITING / children-running stream from its
   * persisted snapshot. Returns true if the host accepted the request
   * (i.e. the resume command dispatched successfully).
   *
   * Returns false if the stream cannot be resumed (no snapshot found,
   * already active/resuming, etc.) — callers should fall back to leaving
   * the message queued for the next manual resume.
   */
  tryResumeStream(
    streamId: StreamTabId,
    recovery?: RecoveryContinuation,
  ): Promise<boolean>;
}
