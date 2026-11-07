/**
 * The process's Effect runtime: one
 * `ManagedRuntime` per process, made at the composition root and disposed
 * on the existing shutdown path. `runPromise`,
 * `runFork`, and `runSync` appear at the entries and at the outermost
 * Promise-facing methods; inside, cancellation is fiber interruption.
 *
 * Held by the entry that made it, never by this module: each composition
 * root keeps its `ManagedRuntime` in a local and threads it to the surfaces
 * that run on it. This module owns the types that describe it, the
 * fork-failure reporting wrapper the roots build it with, and the logger a
 * view's runtime (a webview, the Electron renderer) builds with; there is no
 * ambient slot to read it back from.
 */
import {
  Cause,
  Context,
  Effect,
  Exit,
  type FileSystem,
  type Layer,
  Logger,
  type ManagedRuntime,
  type Path,
  type Scope,
} from 'effect';
import { logEntryOf, writeLogEntry } from '@logger/logSink';
import type { AppSignals } from '@platform/appSignals';
import type { ProcessIdentity } from '@shared/session/sessionEvents';
import {
  DatabaseOpenFailed,
  type CurrentValues,
  type GlobalDatabase,
  type ProjectDatabases,
} from '@shared/session/database';
import type { UsageLog } from '@shared/usageLog';
import type { HttpClient } from 'effect/http';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import type { AgentDirectories, AppState, AppStateStore } from './interfaces';
import type { GlobalStorageFs } from './rootedFs';
import type { Secrets } from './secrets';
import type { SubscriptionAccounts } from '@texra-ai/llm/node';

/**
 * The global root's current values: one row per family and key, replaced in
 * place by each write. A host or plugin keeps its own application state here
 * under a family it declares (`ValueFamily`).
 */
export class GlobalValues extends Context.Service<
  GlobalValues,
  CurrentValues
>()('@texra-ai/harness/GlobalValues') {}

/** The settings stores a host opens for each project it shows. */
export class StateStores extends Context.Service<
  StateStores,
  {
    /** The project's own settings, in its store at `storage`, held for the
     *  caller's scope; it records which root the store serves. */
    readonly project: (
      storage: string,
      workspaceRoot: string | undefined,
    ) => Effect.Effect<AppStateStore, DatabaseOpenFailed, Scope.Scope>;
    /** The settings every checkout of `workspaceRoot`'s repository shares. */
    readonly repo: (
      storage: string,
      workspaceRoot: string | undefined,
    ) => Effect.Effect<AppStateStore>;
  }
>()('@texra-ai/harness/StateStores') {}

/**
 * The platform- and shared-owned services every process serves, merged once
 * in `processLayer`'s `services` layer: the host ports (the secret store with
 * the subscription accounts over it), the language-model bridge and the HTTP
 * client, plus the standard library's `FileSystem`,
 * `Path` and `ChildProcessSpawner`, which the same install provides from
 * `@effect/platform-node` so a program that reads a file or starts a child
 * process takes them from context instead of building a Node layer of its
 * own, and `GlobalStorageFs`, the cross-workspace storage view every session
 * of the process shares, `GlobalDatabase`, that same root's one database
 * handle, which the app's records and the CLI's input history read through,
 * `ProjectDatabases`, whose project-scoped borrows share each persistent
 * connection between application state and a session graph, and
 * `AppSignals`, the process's app-lifecycle signal hub. Every run and
 * session of the process is provided these, beneath the run-level services
 * the agent runtime adds (`RunServices`) and the `ProcessServices` a
 * composition root runs on.
 */
export type PlatformServices =
  | ProcessIdentity
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | GlobalStorageFs
  | GlobalDatabase
  | ProjectDatabases
  | HttpClient.HttpClient
  | Secrets
  | SubscriptionAccounts
  | AppState
  | AgentDirectories
  | GlobalValues
  | StateStores
  | UsageLog
  | AppSignals;

/**
 * The services a step pinned from its plugins' layers (a plugin's
 * `processLayer` and `sessionLayer`), erased: the harness names no plugin's
 * service. A plugin's own code requires them by name, which `definePlugin`
 * checks against what its layers serve, and reaches them
 * only through the step that pinned the plugin, which provides this context
 * to the call.
 */
export type PluginContext = Context.Context<never>;

/**
 * An exit the fiber's interruption produced. Interrupting a consumer of a
 * PubSub-backed stream (`SubscriptionRef.changes`, `Stream.fromPubSub`) adds
 * Effect's end-of-stream `Done` failure beside the interrupt: the channel
 * ends its subscription on interrupt by signalling `Done`. That is the stream
 * closing, not a failure, so an interrupt accompanied only by `Done` counts
 * as an interruption too.
 */
function isInterruption(cause: Cause.Cause<unknown>): boolean {
  return (
    cause.reasons.some(Cause.isInterruptReason) &&
    cause.reasons.every(
      (reason) =>
        Cause.isInterruptReason(reason) ||
        (Cause.isFailReason(reason) && Cause.isDone(reason.error)),
    )
  );
}

/**
 * A runtime whose `runFork` reports a fiber's failure or defect on exit.
 * `Fiber.addObserver` fires on every exit, including fibers a
 * caller later `Fiber.join`s, so a joined failure is logged here and still
 * delivered to the joiner. A success stays silent, as does an exit made of
 * interrupts alone or of interrupts beside Effect's end-of-stream `Done`.
 * `runPromise` and `runSync` hand their exits to the caller already.
 */
export function withForkFailureReporting<R, ER>(
  runtime: ManagedRuntime.ManagedRuntime<R, ER>,
): ManagedRuntime.ManagedRuntime<R, ER> {
  // The report forks on the underlying `runFork`, not the observed one: a
  // defect in the reporter itself must not recurse back into this observer.
  const reportExit = (
    fiberId: number,
    exit: Exit.Exit<unknown, unknown>,
  ): void => {
    if (Exit.isSuccess(exit) || isInterruption(exit.cause)) return;
    runtime.runFork(
      Effect.logError('Unhandled failure in forked fiber', exit.cause).pipe(
        Effect.annotateLogs({ forkedFiber: fiberId }),
      ),
    );
  };
  return {
    ...runtime,
    runFork: (effect, options) => {
      const fiber = runtime.runFork(effect, options);
      fiber.addObserver((exit) => reportExit(fiber.id, exit));
      return fiber;
    },
  };
}

/**
 * The logger of a view's runtime, which builds no process diagnostics layer:
 * each entry takes the log sink's write path, redacted unless a host marked
 * the sink trusted, instead of Effect's default console logger. An entry
 * keeps its level: fork-failure reports and fold defects show in DevTools
 * as the errors they are.
 */
export const viewDiagnosticsLayer: Layer.Layer<never> = Logger.layer([
  Logger.make((options) => {
    const entry = logEntryOf(options);
    if (!entry) return;
    writeLogEntry(entry);
  }),
]);
