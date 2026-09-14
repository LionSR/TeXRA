/**
 * Platform port contracts — the host-neutral interfaces a host wires into
 * `initPlatform()`. Formerly one file per port under `interfaces/`.
 */
import { Context, Data, Effect, Layer } from 'effect';
import type { RunId } from '@shared/schemas';

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
  update<T>(
    key: string,
    value: T,
    target?: ConfigTarget,
  ): Effect.Effect<void, StoreWriteFailed>;
  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined;
  isExplicitlySet(key: string): boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Why a durable settings or state write failed. Both stores persist through
 * the same two owners, so they share one vocabulary:
 *
 * - `not-serializable` — the value handed in is not JSON, so nothing was
 *   written (`appStateStore`'s encode step).
 * - `io` — the backing store rejected the write: a Node errno from the JSON
 *   file, a corrupt store file, or a database append that failed.
 */
export type StoreWriteFailureReason = 'not-serializable' | 'io';

/**
 * The one failure of a {@link StateStore} or {@link ConfigProvider} write.
 * Callers match `reason` instead of a message; nothing here is a silent
 * default.
 */
export class StoreWriteFailed extends Data.TaggedError('StoreWriteFailed')<{
  readonly reason: StoreWriteFailureReason;
  readonly key: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Platform key-value state store interface.
 *
 * Reads stay synchronous over the snapshot the store opened with — the
 * `vscode.Memento` shape every host already serves. Writes are `Effect`s:
 * the failure is typed as {@link StoreWriteFailed} and the write is a step of
 * the program that asked for it rather than a floating promise.
 */
export interface StateStore {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): Effect.Effect<void, StoreWriteFailed>;
}

/**
 * The process's global state store as an Effect service
 * (`@texra/platform/AppState`, injection plan §5 row 2), provided once by the
 * composition root through `installProcessRuntime`. The service is the store
 * itself: the port is Effect-typed, so nothing stands between a
 * `yield* AppState` and the host's own program.
 *
 * `layer` takes the store's open program rather than the store, for the same
 * reason `Secrets.layer` does: a `ManagedRuntime` builds its layer at its
 * first run, and in the desktop and CLI roots that first run is what opens
 * this store. Opening it as the layer's build step gives the process exactly
 * one instance and removes the late binding the roots used to need.
 */
export class AppState extends Context.Service<AppState, StateStore>()(
  '@texra/platform/AppState',
) {
  static layer<R>(
    open: Effect.Effect<StateStore, never, R>,
  ): Layer.Layer<AppState, never, R> {
    return Layer.effect(AppState)(open);
  }
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
   * exactly one writer (a run-lease claim), where `writeFileAtomic`'s
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
  /**
   * True from the moment `runShutdown()` is first called. Each phase drains
   * exactly once and the drain is cached, so a handler registered from here
   * on is never run: a caller whose cleanup depends on this path must read
   * this before taking a resource it would register here.
   */
  readonly shutdownRan: boolean;
}

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
  readonly runId: RunId;
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
  tryResumeRun(runId: RunId, recovery?: RecoveryContinuation): Promise<boolean>;
}
