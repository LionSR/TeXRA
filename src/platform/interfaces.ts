/**
 * Platform port contracts — the host-neutral interfaces a host wires into
 * `initPlatform()`. Formerly one file per port under `interfaces/`.
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

  /**
   * Whether the host's workspace source differs from the storage root
   * currently exposed to callers. Providers with a dynamic workspace source
   * keep the old root pinned until the change is committed.
   */
  hasPendingWorkspaceStorageChange?(target?: {
    workspacePath: string | undefined;
  }): boolean;

  /**
   * Expose a captured workspace source as the new storage root. The runtime
   * calls this only after execution ownership at the old root is quiescent.
   * Returns whether the exposed root changed.
   */
  commitWorkspaceStorageChange?(target?: {
    workspacePath: string | undefined;
  }): boolean;

  /** Finalize a successfully loaded workspace-storage replacement. */
  finalizeWorkspaceStorageChange?(): void;

  /**
   * Restore the root exposed before the most recent commit. Returns whether a
   * pending commit was rolled back.
   */
  rollbackWorkspaceStorageChange?(): boolean;
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
  onShutdown(
    phase: ShutdownPhase,
    callback: () => void | Promise<void>,
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
  readonly generation: number;
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
