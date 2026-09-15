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
 * A configuration write the store refused. Every implementation bottoms out in
 * the same `JsonStore` as the secret and state stores, so the reasons are that
 * store's: a filesystem error under the config path, or a config file whose
 * contents are no longer a JSON object.
 *
 * {@link ConfigProvider.update} raises it as the failure of the write itself,
 * so a caller inside a program composes the write rather than adopting a
 * rejection it cannot type.
 */
export class ConfigWriteFailed extends Data.TaggedError('ConfigWriteFailed')<{
  readonly key: string;
  readonly target: ConfigTarget | undefined;
  readonly message: string;
  readonly cause: unknown;
}> {}

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
  /**
   * Persist one value to the target's store. The write is an `Effect` so it
   * composes directly into the caller's program: the store's own write is an
   * Effect, and a Promise face here could only be an injected runner that
   * executes that Effect on the caller's behalf.
   */
  update<T>(
    key: string,
    value: T,
    target?: ConfigTarget,
  ): Effect.Effect<void, ConfigWriteFailed>;
  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined;
  isExplicitlySet(key: string): boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * A state write the store refused: the host's own `Memento` rejection on the
 * extension, and the shared `JsonStore`'s filesystem or not-JSON failure on
 * the desktop, the CLI and the agent package.
 *
 * {@link StateStore.update} keeps `vscode.Memento`'s `PromiseLike` shape for
 * the same reason {@link ConfigWriteFailed} exists: the writes travel with the
 * config slots beside them. This is the tag its Effect-side callers raise.
 */
export class StateWriteFailed extends Data.TaggedError('StateWriteFailed')<{
  readonly key: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * Platform key-value state store interface.
 * Matches the vscode.Memento surface for compatibility.
 */
export interface StateStore {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * The process's global state store as an Effect service
 * (`@texra/platform/AppState`, injection plan §5 row 2), provided once by the
 * composition root through `installProcessRuntime`. The shape stays the
 * synchronous `StateStore`; Effect-typing it is its own step.
 *
 * `layer` takes the store itself, for the same reason `Secrets.layer` does:
 * every root opens its state store before installing the runtime that serves
 * it, so the service is that store rather than a thunk resolved per member
 * call.
 */
export class AppState extends Context.Service<AppState, StateStore>()(
  '@texra/platform/AppState',
) {
  static layer(store: StateStore): Layer.Layer<AppState> {
    return Layer.succeed(AppState)(store);
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
