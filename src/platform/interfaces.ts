/**
 * Platform port contracts — the host-neutral interfaces a host wires into
 * `initPlatform()`. Formerly one file per port under `interfaces/`.
 */
import { Context, Data, Effect, FileSystem, Layer } from 'effect';
import type { AgentSource, RunId } from '@shared/schemas';

import type { GlobalStorageFs } from './rootedFs';

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
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * A state write the store refused: the host's own `Memento` rejection on the
 * extension, and the shared `JsonStore`'s filesystem or not-JSON failure on
 * the desktop, the CLI and the agent package.
 *
 * {@link StateStore.update} raises it as the failure of the write itself, for
 * the same reason {@link ConfigWriteFailed} exists: the writes travel with the
 * config slots beside them, so a caller inside a program composes the write
 * rather than adopting a rejection it cannot type.
 */
export class StateWriteFailed extends Data.TaggedError('StateWriteFailed')<{
  readonly key: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * Platform key-value state store interface.
 *
 * `get` keeps `vscode.Memento`'s synchronous shape. `update` does not: it is
 * an `Effect` so it composes directly into the caller's program, for the same
 * reason {@link ConfigProvider.update} is one. An implementation wrapping a
 * host `Memento`, whose own `update` is a `PromiseLike`, is the one place that
 * adopts the promise and raises {@link StateWriteFailed} for it.
 */
export interface StateStore {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): Effect.Effect<void, StateWriteFailed>;
}

/**
 * The process's global state store as an Effect service
 * (`@texra/platform/AppState`, injection plan §5 row 2), provided once by the
 * composition root through `installProcessRuntime`.
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
// Lifecycle
// ---------------------------------------------------------------------------

export const SHUTDOWN_PHASE = {
  BEFORE: 'beforeShutdown',
  ON: 'onShutdown',
} as const;

export type ShutdownPhase =
  (typeof SHUTDOWN_PHASE)[keyof typeof SHUTDOWN_PHASE];

/**
 * One registered shutdown handler: the program the drain runs at its phase,
 * not a callback it calls. A failure is reported to the drain's `onError`,
 * which is why the channel is open here: the drain is the boundary that
 * reports it, and no caller of `runShutdown` adopts it.
 */
export type ShutdownHandler = Effect.Effect<void, unknown>;

export interface LifecycleHost {
  /**
   * Register a shutdown handler. The phase's join-with-deadline is fiber
   * interruption: a handler still running at the deadline is interrupted and
   * the drain advances past it, so a handler that can be safely cut short
   * needs nothing of its own, and one whose work must outlast the deadline
   * says so with `Effect.uninterruptible`.
   */
  onShutdown(phase: ShutdownPhase, handler: ShutdownHandler): Disposable;
  /**
   * Drain both phases, once: concurrent callers join the drain in flight
   * rather than starting a second one.
   */
  readonly runShutdown: Effect.Effect<void>;
  /**
   * True from the moment `runShutdown` is first run. Each phase drains
   * exactly once and the drain is cached, so a handler registered from here
   * on is never run: a caller whose cleanup depends on this path must read
   * this before taking a resource it would register here.
   */
  readonly shutdownRan: boolean;
}

// ---------------------------------------------------------------------------
// Agent directories
// ---------------------------------------------------------------------------

/**
 * A host could not resolve one of its agent directories: the configured
 * custom directory is not an absolute path, its parent is gone, it cannot be
 * created, or the platform refused the filesystem call behind either.
 *
 * {@link AgentDirectoriesPort}'s three readers raise it as the failure of the
 * read itself, for the same reason {@link StateWriteFailed} exists: the reads
 * travel with the agent-catalog load beside them, so a caller inside a program
 * composes the read rather than adopting a rejection it cannot type.
 */
export class AgentDirectoriesFailed extends Data.TaggedError(
  'AgentDirectoriesFailed',
)<{
  /** Which of the port's readers failed. */
  readonly source: AgentSource;
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * Host-provided agent directory paths. All three are `Effect`s (not Promises)
 * so the one reader that can fault — `custom`, which creates the directory it
 * resolves — carries its failure into the catalog load that asked for it
 * instead of rejecting an await that cannot name it.
 *
 * `custom` takes the process's {@link GlobalStorageFs} and the process
 * `FileSystem` from context: the default custom-agents directory lives under
 * the cross-workspace storage root, and a configured one is an absolute path
 * outside every root, so the view that names each is the one the process
 * runtime provides.
 */
export interface AgentDirectoriesPort {
  custom(): Effect.Effect<
    string,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  >;
  builtIn(): Effect.Effect<string, AgentDirectoriesFailed>;
  builtInToolUse(): Effect.Effect<string, AgentDirectoriesFailed>;
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

/**
 * A host's resume attempt faulted before it could answer. Distinct from the
 * `false` {@link AgentResumePort.tryResumeRun} answers: `false` is this
 * process declining a run it can classify, while this is the attempt itself
 * failing, which the caller cannot read off the boolean.
 */
export class AgentResumeFailed extends Data.TaggedError('AgentResumeFailed')<{
  readonly runId: RunId;
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface AgentResumePort {
  /**
   * Attempt to resume a WAITING / children-running stream from its
   * persisted snapshot. Resolves true if the host accepted the request
   * (i.e. the resume command dispatched successfully).
   *
   * Resolves false if the stream cannot be resumed (no snapshot found,
   * already active/resuming, etc.) — callers should fall back to leaving
   * the message queued for the next manual resume. The failure channel is
   * reserved for the attempt faulting, so a caller that only wants the
   * retry decision still learns when the decision itself could not be made.
   */
  tryResumeRun(
    runId: RunId,
    recovery?: RecoveryContinuation,
  ): Effect.Effect<boolean, AgentResumeFailed>;
}

/**
 * The process's agent-resume port as an Effect service
 * (`@texra/platform/AgentResume`), provided once by the composition root
 * through `installProcessRuntime`. The shape is the port itself: a program
 * that resumes a persisted run yields the port's own Effect and matches
 * {@link AgentResumeFailed}.
 *
 * `layer` takes the port itself, for the same reason `Secrets.layer` does:
 * every root builds its resume port before it installs the runtime that
 * serves it, so the service is the value the root already holds, not a thunk
 * resolved per member call.
 */
export class AgentResume extends Context.Service<
  AgentResume,
  AgentResumePort
>()('@texra/platform/AgentResume') {
  static layer(port: AgentResumePort): Layer.Layer<AgentResume> {
    return Layer.succeed(AgentResume)(port);
  }
}
