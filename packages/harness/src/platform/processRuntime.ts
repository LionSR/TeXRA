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
  Path,
  type Scope,
} from 'effect';
import type { RouteRetries } from '@agent/runtime/run/invocation';
import type { SessionOwnerShape } from '@agent/runtime/SessionHandle';
import { writeLogEntry } from '@logger/logSink';
import type { ProcessIdentity } from '@shared/session/sessionEvents';
import {
  DatabaseOpenFailed,
  type CurrentValues,
  type GlobalDatabase,
  type ProjectDatabases,
} from '@shared/session/database';
import type { UsageLog } from '@shared/usageLog';
import type { ToolCatalog, ToolCatalogOwner } from '@tools/liveTools';
import type { ToolAvailability } from '@tools/toolAvailabilityService';
import type { ToolRegistry } from '@tools/toolTable';
import type { HttpClient } from 'effect/http';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import type { AgentDirectories, AppState, AppStateStore } from './interfaces';
import type { LanguageModel } from './languageModel';
import type { GlobalStorageFs } from './rootedFs';
import type { Secrets } from './secrets';

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
 * The runtime over the process-lifetime services every entry provides: the
 * cohort-A tags, the language-model bridge and the HTTP client, merged once in
 * `processLayer`'s `services` layer, plus the standard library's
 * `FileSystem`, `Path` and `ChildProcessSpawner`, which the same install
 * provides from `@effect/platform-node` so a program that reads a file or
 * starts a child process takes them from context instead of building a Node
 * layer of its own, and
 * `GlobalStorageFs`, the cross-workspace storage view every session of the
 * process shares, `GlobalDatabase`, that same root's one database handle,
 * which the app's records and the CLI's input history read through,
 * `ProjectDatabases`, whose project-scoped borrows share each persistent
 * connection between application state and a session graph, `ToolRegistry`,
 * the plugin table every run's offered tools are rebuilt from,
 * `ToolCatalog` (with `ToolCatalogOwner`, its owner's view), the tool catalog
 * each session's steps pin their tools in, and
 * `ToolAvailability`, each workspace's last dependency probe. Every run
 * and session of the process is provided these; the `SessionOwner` above
 * them is the composition root's alone ({@link ProcessRuntime}).
 */
export type ProcessServices =
  | ProcessIdentity
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | GlobalStorageFs
  | GlobalDatabase
  | ProjectDatabases
  | HttpClient.HttpClient
  | Secrets
  | AppState
  | LanguageModel
  | AgentDirectories
  | GlobalValues
  | StateStores
  | UsageLog
  | ToolRegistry
  | ToolCatalog
  | ToolCatalogOwner
  | ToolAvailability
  | RouteRetries;

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
 * The services an agent catalog load reads: the global and filesystem views
 * the local agent directories are scanned through, the app state the
 * disabled-plugin switch is read from, and the plugin table whose agent-file
 * blocks a scan admits.
 */
export type AgentCatalogServices =
  | GlobalStorageFs
  | FileSystem.FileSystem
  | AgentDirectories
  | AppState
  | ToolRegistry;

/**
 * The process's session owner: one session per workspace storage root,
 * served by `processLayer` over the `LayerMap` that owns every session's
 * lifetime; its shape is
 * {@link SessionOwnerShape}.
 */
export class SessionOwner extends Context.Service<
  SessionOwner,
  SessionOwnerShape
>()('@texra-ai/harness/SessionOwner') {}

/** A root's holder (one composition) and how many of its sessions hold it. */
type RootHold = { readonly holder: object; count: number };
const PROCESS_ROOTS = Symbol.for('@texra-ai/harness/processRoots');
const openRoots = (): Map<string, RootHold> => {
  // cast: globalThis carries this one well-known symbol key, set only here.
  const process = globalThis as { [PROCESS_ROOTS]?: Map<string, RootHold> };
  // On globalThis: one per PROCESS, not per copy of this module (an app
  // bundle beside an SDK consumer or a jiti-loaded plugin each load one).
  return (process[PROCESS_ROOTS] ??= new Map());
};

/**
 * The process's one guard on a root's owner: a composition (one
 * `processLayer` build, so one `Sessions.layer` build) holds a root, for the
 * scope of one of its sessions, only if no other composition in this process
 * holds it, since both would own its runs under one process identity. The
 * root is keyed by its resolved path, so a trailing slash or a `..` names the
 * same root. A refusal is the open's failure.
 */
export const holdProcessRoot = (
  root: string,
  holder: object,
): Effect.Effect<void, DatabaseOpenFailed, Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    // Resolved without I/O: a session opens synchronously (`runSync`).
    const canonical = (yield* Path.Path).resolve(root);
    const take = Effect.suspend(() => {
      const held = openRoots().get(canonical);
      if (held === undefined) openRoots().set(canonical, { holder, count: 1 });
      else if (held.holder === holder) held.count += 1;
      else
        return Effect.fail(
          new DatabaseOpenFailed({
            path: root,
            cause: new Error(
              `The session at ${root} is already open in this process; share that session instead of opening it from a second composition (Sessions.layer build).`,
            ),
          }),
        );
      return Effect.void;
    });
    // Counted, so a reopen racing a close of the same root keeps its hold.
    yield* Effect.acquireRelease(take, () =>
      Effect.sync(() => {
        const held = openRoots().get(canonical);
        if (held !== undefined && --held.count === 0)
          openRoots().delete(canonical);
      }),
    );
  });

/** The runtime a composition root makes over `processLayer`: the process
 *  services, and the `SessionOwner` that opens and closes its sessions. */
export type ProcessRuntime = ManagedRuntime.ManagedRuntime<
  ProcessServices | SessionOwner,
  never
>;

/**
 * `effect` over this runtime's services, as a program rather than a run: a
 * composition root hands the process services to a program it must give away
 * — a shutdown handler, a host callback typed as an Effect — without
 * stepping through a Promise to get them. The services are the runtime's own
 * context, built once and cached there, so this is the same provision
 * `runPromise` would have made, minus the boundary.
 */
export function withProcessServices<A, E>(
  // Not named `runtime`: the migration ratchet pins this file's one approved
  // `runtime` binding to `withForkFailureReporting`'s parameter.
  processRuntime: ProcessRuntime,
  effect: Effect.Effect<A, E, ProcessServices | SessionOwner>,
): Effect.Effect<A, E> {
  return Effect.flatMap(processRuntime.contextEffect, (context) =>
    Effect.provide(effect, context),
  );
}

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
 * the sink trusted, instead of Effect's default console logger.
 *
 * ERROR/FATAL are written as WARN: a view has no host log channel, and
 * Electron's smoke harness treats `console.error` (the console sink's ERROR
 * path) as a failed view. Fork-failure reports and fold defects still show
 * in DevTools after redaction.
 */
export const viewDiagnosticsLayer: Layer.Layer<never> = Logger.layer([
  Logger.make((options) => {
    if (options.logLevel === 'None') return;
    const entry = Logger.formatStructured.log(options);
    writeLogEntry(
      entry.level === 'ERROR' || entry.level === 'FATAL'
        ? { ...entry, level: 'WARN' }
        : entry,
    );
  }),
]);
