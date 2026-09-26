/**
 * Platform port contracts — the host-neutral interfaces a host wires into
 * `installProcessRuntime()`. Formerly one file per port under `interfaces/`.
 */
import { Context, Data, Effect, FileSystem, Layer } from 'effect';
import type { AgentSource, RunId } from '@shared/schemas';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

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
   *
   * It stays synchronous by ruling, and it casts: the value it returns is
   * whatever the store holds. A reader that needs the value checked reads
   * through `readSettingFrom` (`@utils/config/platformSettings`), which
   * resolves the key's catalog row and safe-parses the stored value against
   * the row's schema; a hand-edited `"false"` in a boolean row is a truthy
   * string here and silently means the opposite. Nothing may cache what
   * either read returns: a setting the user changes mid-process is read on
   * the next call.
   *
   * Path conventions:
   * - Use dot notation with or without the canonical `texra.` prefix.
   * - Host settings such as `latex-workshop.*` must use the host adapter
   *   rather than this shared configuration path.
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

/** An authoritative state read failed; absence is a successful read. */
export class StateReadFailed extends Data.TaggedError('StateReadFailed')<{
  readonly key: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/** A host or database refused an application-state write. */
export class StateWriteFailed extends Data.TaggedError('StateWriteFailed')<{
  readonly key: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * Application state read from its authority when the Effect executes.
 * Updates finish after commit. Separate reads and updates are not an atomic
 * read-modify-write operation — run one under {@link withStateKeyLane};
 * defaults apply only to absent keys.
 */
export interface StateStore {
  get<T>(key: string, defaultValue?: T): Effect.Effect<T, StateReadFailed>;
  update(key: string, value: unknown): Effect.Effect<void, StateWriteFailed>;
}

const stateKeyLanes = new Map<string, PerKeyLane>();

/**
 * Run a read-modify-write of one state key on that key's lane, so overlapping
 * edits (the settings surfaces do not serialize their messages) each read the
 * other's committed value instead of the later write dropping the earlier.
 */
export function withStateKeyLane(
  key: string,
): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
  return withPerKeyLane(stateKeyLanes, key);
}

/**
 * Global application state, provided by the process's composition layer.
 * Hosts supplying an existing store use `layer`; SQLite hosts acquire their
 * store in the runtime's scope, sharing the global database where appropriate.
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

/**
 * The drain's three phases, in order, each with its own deadline budget.
 * `RELEASE` follows every `ON` handler, whenever it was registered: it is
 * where the process's sessions and then its runtime are released, so no
 * handler can run on a runtime already gone.
 */
export const SHUTDOWN_PHASE = {
  BEFORE: 'beforeShutdown',
  ON: 'onShutdown',
  RELEASE: 'releaseProcess',
} as const;

export type ShutdownPhase =
  (typeof SHUTDOWN_PHASE)[keyof typeof SHUTDOWN_PHASE];

/**
 * One registered shutdown handler: the program the drain runs at its phase,
 * not a callback it calls. A failure is reported to the drain's `onError`,
 * which is why the channel is any `Error` here: the drain is the boundary
 * that reports it, and no caller of `runShutdown` adopts it.
 */
export type ShutdownHandler = Effect.Effect<void, Error>;

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
   * Drain the phases, once: concurrent callers join the drain in flight
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

/**
 * The process's shutdown lifecycle as an Effect service
 * (`@texra/platform/Lifecycle`), provided once by the composition root through
 * `installProcessRuntime`. The shape is the host itself: a program that
 * registers a shutdown handler or drains the phases yields this rather than
 * reading whichever lifecycle the process platform happens to hold.
 *
 * `layer` takes the host itself, for the same reason `Secrets.layer` does:
 * every root builds its lifecycle before it installs the runtime that serves
 * it, so the service is the value the root already holds.
 */
export class Lifecycle extends Context.Service<Lifecycle, LifecycleHost>()(
  '@texra/platform/Lifecycle',
) {
  static layer(lifecycle: LifecycleHost): Layer.Layer<Lifecycle> {
    return Layer.succeed(Lifecycle)(lifecycle);
  }
}

// ---------------------------------------------------------------------------
// Agent directories
// ---------------------------------------------------------------------------

/**
 * A host could not resolve one of its agent directories: the configured
 * custom directory is not an absolute path, its parent is gone, it cannot be
 * created, or the platform refused the filesystem call behind either.
 *
 * {@link AgentDirectoriesPort}'s readers raise it as the failure of the
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
 * Host-provided agent directory paths. All are `Effect`s (not Promises)
 * so the readers that can fault — `custom`, which creates the directory it
 * resolves, and `customConfigured`, which validates the setting — carry their
 * failure into the program that asked instead of rejecting an await that
 * cannot name it.
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
  /** Whether `custom` resolves to a directory the user configured, rather
   *  than falling back to the default one under global storage. */
  customConfigured(): Effect.Effect<
    boolean,
    AgentDirectoriesFailed,
    FileSystem.FileSystem
  >;
  builtIn(): Effect.Effect<string, AgentDirectoriesFailed>;
  builtInToolUse(): Effect.Effect<string, AgentDirectoriesFailed>;
}

/**
 * The process's agent directories as an Effect service
 * (`@texra/platform/AgentDirectories`), provided once by the composition root
 * through `installProcessRuntime`. The shape is the port itself: a program
 * that resolves one of the three local agent directories yields the port's own
 * readers instead of reaching for the process platform's copy.
 *
 * `layer` takes the port itself, for the same reason `Secrets.layer` does:
 * every root builds its agent directories before it installs the runtime that
 * serves them, so the service is the value the root already holds.
 */
export class AgentDirectories extends Context.Service<
  AgentDirectories,
  AgentDirectoriesPort
>()('@texra/platform/AgentDirectories') {
  static layer(
    directories: AgentDirectoriesPort,
  ): Layer.Layer<AgentDirectories> {
    return Layer.succeed(AgentDirectories)(directories);
  }
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

// ---------------------------------------------------------------------------
// Tool-missing reporter
// ---------------------------------------------------------------------------

/**
 * The host's optional "tool is missing" reporter. The VS Code host is the only
 * one with a UI for it; every other host omits it, and callers treat an absent
 * reporter as silence. It settles its own presentation failures, so the probe
 * that reports a missing tool still gets its answer.
 */
export type ToolMissingHandler = (
  message: string,
  openDocsCommand?: string,
) => Effect.Effect<void>;

/**
 * The process's tool-missing reporter as an Effect service
 * (`@texra/platform/ToolMissingReporter`), provided once by the composition
 * root through `installProcessRuntime`. A program that needs to surface a
 * missing tool yields it via `Effect.serviceOption`, so an absent reporter is
 * silence rather than a missing requirement.
 *
 * `layer` takes the reporter the root already holds; a host without a
 * tool-missing UI omits the service, exactly as it omitted the platform port.
 */
export class ToolMissingReporter extends Context.Service<
  ToolMissingReporter,
  ToolMissingHandler
>()('@texra/platform/ToolMissingReporter') {
  static layer(report: ToolMissingHandler): Layer.Layer<ToolMissingReporter> {
    return Layer.succeed(ToolMissingReporter)(report);
  }
}
