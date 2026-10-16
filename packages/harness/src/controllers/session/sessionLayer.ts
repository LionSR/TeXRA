/**
 * {@link ownerProcessLayer}: the process services and the `SessionOwner` over
 * a `LayerMap` of sessions, one per storage root, each entry the root-scoped
 * services and the `SessionHandle` over them. Two opens of a root return one
 * handle; an open borrows, `close` settles and releases, and the layer's
 * release closes whatever is still open.
 */
import {
  Cause,
  Context,
  Duration,
  Effect,
  Equal,
  FiberSet,
  Hash,
  Layer,
  LayerMap,
  Option,
  RcMap,
  Stream,
  SubscriptionRef,
  Scope,
} from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';

import { Inbox } from '@agent/followUp/Inbox';
import {
  executeAgent,
  resumeToolUseFromResumeData,
} from '@agent/runtime/executeAgent';
import { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import { HistoryQuery } from '@agent/runtime/historyQuery/HistoryQuery';
import { ModelRetryGate } from '@agent/runtime/ModelRetryGate';
import { RouteRetries } from '@agent/runtime/run/invocation';
import { resumeRun } from '@agent/runtime/resumeRun';
import { rootRun } from '@agent/runtime/rootLaunch';
import {
  endRunOutsideLifecycle,
  onHeldResult,
} from '@agent/runtime/runLaunchGuard';
import { createSessionApprovals } from '@agent/runtime/runApprovalQueue';
import { makeRunHistory } from '@agent/runtime/RunHistory';
import { registryOf, RunRegistry } from '@agent/runtime/runRegistry';
import { sessionEventsLayer } from '@agent/runtime/SessionEvents';
import {
  SESSION_CLOSE_DEADLINE_MS,
  type SessionHandle,
  type SessionHandleInit,
} from '@agent/runtime/SessionHandle';
import { presentTerminalResult } from '@agent/runtime/terminalResultToast';
import { withLogChannel } from '@logger/effectLog';
import {
  effectDiagnosticsLayer,
  type MinimumLogLevel,
} from '@logger/effectDiagnostics';
import {
  holdProcessRoot,
  SessionOwner,
  type ProcessServices,
} from '@platform/processRuntime';
import {
  AgentDirectories,
  AppState,
  ToolMissingReporter,
  type ToolMissingHandler,
} from '@platform/interfaces';
import { LanguageModel, type LanguageModelPort } from '@platform/languageModel';
import { globalStorageFsLayer } from '@platform/rootedFs';
import { Secrets, type PlatformSecrets } from '@platform/secrets';
import {
  nodeProcesses,
  processOwnerId,
  type ProcessProbe,
} from '@platform/defaults/nodeProcesses';
import {
  nodePlatformServices,
  workspaceEnvironmentLayer,
} from '@platform/defaults/nodePlatform';
import {
  aggregateTarget,
  RUN_OUTCOME,
  type RunId,
  type SessionCloseReport,
} from '@shared/schemas';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import {
  Database,
  ProjectDatabases,
  type DatabaseOpenFailed,
  type DatabaseReadFailed,
  GlobalDatabase,
  SessionOptionsConflict,
  type SessionOpenError,
} from '@shared/session/database';
import { UsageLog } from '@shared/usageLog';
import { ToolCatalog } from '@tools/liveTools';
import { pluginCatalogLayer } from '@tools/pluginCatalog';
import type { Plugin } from '@tools/plugins';
import { toolAvailabilityLayer } from '@tools/toolAvailability';
import { ToolAvailability } from '@tools/toolAvailabilityService';
import { ToolRegistry } from '@tools/toolTable';
import { agentCatalogFollower } from '@tools/agentCatalogFollower';
import { followInterruptedTasks } from '@tools/interruptedTasks';
import { databaseLayer, globalDatabaseLayer } from './Database';
import { projectDatabaseLayer } from './projectDatabase';
import { deletionCollector, type RunFilesServices } from './deletionCleanup';
import { ownerLiveness } from './ownerLiveness';
import { sessionRequests } from './SessionRequests';
import { makeSessionStore } from './sessionStore';
import { sweepLeftoverRuns } from './sweepLeftoverRuns';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from './sessionSources';
import { makeSessionViewAccess, SessionViewService } from './SessionView';
import { sessionInputsLayer } from './sessionInputs';
import { WorkspaceRoots } from './WorkspaceRoots';

const CHANNEL = 'sessionLayer';

/** Log a failure on this channel, with the failure attached as its `data`. */
const logFailure =
  (message: string, log = Effect.logWarning) =>
  (data: unknown) =>
    log(message).pipe(Effect.annotateLogs({ data }), withLogChannel(CHANNEL));

/**
 * Which session an entry is: its storage root (`SessionView.key`), with what
 * the opener supplied for building it. Equal and hashed by the root alone:
 * two opens of one root resolve one session, over what the first supplied,
 * and nothing store-bound is injected past that (PR #11893, section 3).
 */
class SessionKey implements Equal.Equal {
  constructor(readonly open: SessionHandleInit) {}

  get storage(): string {
    return this.open.roots.storage;
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof SessionKey && that.storage === this.storage;
  }

  [Hash.symbol](): number {
    return Hash.string(this.storage);
  }
}

/** The session of one root: the handle the map built over the root's graph. */
class Session extends Context.Service<Session, SessionHandle>()(
  '@texra/session/Session',
) {}

/**
 * The handle of one root over its graph: the entry's one service and last
 * layer, so it unwinds first and the graph outlives every publisher above
 * it. The entry's scope is the session's one lifetime ({@link closeSession}
 * and disposal close it); every owner it holds has a finalizer here.
 */
const sessionHandleLayer = (key: SessionKey) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const database = yield* Database;
      const plugins = yield* ToolRegistry;
      const local = yield* LocalRuntimeSource;
      // Register the consumers' scope first so the handle's teardown can
      // publish and settle while the tails and the view are still alive.
      const consumerScope = yield* Effect.acquireRelease(
        Scope.make(),
        (scope, exit) => Scope.close(scope, exit),
      );
      const store = yield* makeSessionStore(key.storage);
      // A pass over the pending tombstones, at open and after each removal.
      const collectDeletions = yield* deletionCollector(database, key.storage);
      const view = yield* makeSessionViewAccess(key.storage, store.closed);
      // Capture the startup cohort before callers can publish new launches.
      const initialListing = yield* database.readListing();
      // The publisher drains inside the one close deadline, after the runs'
      // fibers (registered before their fork) published their last rows.
      yield* Effect.addFinalizer(() => store.close);
      // The runs' fork and the project's tools end with this scope.
      const fork = yield* FiberSet.makeRuntime<ProcessServices>();
      const tools = yield* (yield* ToolCatalog).session;
      const interactions = new SessionHostInteractions();
      // Each run's `.env`, read as it launches, and its window's models.
      const env = Layer.merge(
        workspaceEnvironmentLayer(key.open.roots.workspace),
        LanguageModel.layer(
          yield* LanguageModel,
          () => interactions.languageModel,
        ),
      );
      const runs = new RunRegistry({
        session: () => session,
        fork: (run) => fork(Effect.provide(run, env)),
        programs: {
          root: rootRun,
          executeAgent,
          resumeTurn: resumeToolUseFromResumeData,
          resume: resumeRun,
        },
      });
      const session: SessionHandle = {
        roots: key.open.roots,
        log: store.log,
        view,
        runs,
        tools,
        requests: sessionRequests({
          session: () => session,
          log: {
            ...database,
            removeRun: (id, mode, start) =>
              Effect.tap(
                store.removeRun(id, mode, start),
                () => collectDeletions,
              ),
            detach: store.detach,
          },
          local: local.ref,
          plugins,
          services: yield* Effect.context<GlobalDatabase | RunFilesServices>(),
          closed: store.closed,
        }),
        approvals: createSessionApprovals(() => session),
        interactions,
        followUps: new Inbox({
          log: store.log,
          detach: store.detach,
          parentOf: (runId) => view.run(runId)?.parentId,
          live: (runId) => runs.get(runId)?.live === true,
        }),
        trace: store.trace,
        runHistory: makeRunHistory(store.log),
        history: yield* HistoryQuery.make(() => session),
      };
      // The session's teardown is this scope's finalizers, run in the reverse
      // of their registration: first the runs, so no run is admitted over a
      // session that is unwinding; then the presentation hosts, the follow-up
      // queue, the runs' fibers; and last the doors, after the publisher
      // drained (registered above the fork).
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => session.followUps.dispose()),
      );
      yield* Effect.addFinalizer(() => session.interactions.dispose());
      yield* Effect.addFinalizer(() => Effect.sync(() => runs.dispose()));
      // An opener's presentation host attaches as its own step: `use`
      // replays its queue, a program a constructor cannot run.
      if (key.open.interactions)
        yield* session.interactions.use(key.open.interactions);
      // The local half of a committed removal; its plugin rows go with it.
      yield* store
        .deliver((runId) => session.followUps.forget(runId))
        .pipe(Scope.provide(consumerScope));
      // The registry's phase notification rides the fold-gated tail: its
      // waiters read `RunView.status` synchronously, so a row reaches them
      // once the view holds its state. Host notices go to the author.
      yield* Stream.runForEach(store.folded, (event) =>
        Effect.gen(function* () {
          const target = aggregateTarget(event.aggregateId);
          yield* onHeldResult(session, event, consumerScope);
          if (target.kind !== 'run' || event.type !== 'run.end') return;
          const { self } = yield* SubscriptionRef.get(local.ref);
          if (event.origin == null || !self.includes(event.origin)) return;
          if (!store.closed())
            yield* Effect.suspend(() =>
              presentTerminalResult(session, { ...event, runId: target.id }),
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning('Terminal result presentation threw').pipe(
                  Effect.annotateLogs({ data: Cause.squash(cause) }),
                  withLogChannel(CHANNEL),
                ),
              ),
            );
          runs.sweepChildrenOfFoldedStop(target.id);
        }),
      ).pipe(
        Effect.catch(
          logFailure(
            `Session ${key.storage} stopped delivering folded rows: the log could not be read.`,
            Effect.logError,
          ),
        ),
        Effect.forkIn(consumerScope),
      );
      yield* sweepLeftoverRuns(session, initialListing).pipe(Effect.forkScoped);
      if (key.open.interruptedTasks !== undefined)
        yield* followInterruptedTasks(
          session,
          key.open.interruptedTasks === 'offer',
        ).pipe(
          Effect.catch(
            logFailure(
              `Session ${key.storage} stopped following its interrupted tasks.`,
            ),
          ),
          Effect.forkScoped,
        );
      yield* collectDeletions;
      // Held for the session's life and probed beside the open, so no step
      // waits for it (the gate withholds nothing until it answers).
      yield* (yield* ToolAvailability).hold(key.open.roots);
      return Context.make(Session, session);
    }),
  );

/** The runtime graph of one root (PRD 7.3): the root-scoped services the
 *  handle is built over. */
const sessionGraphLayer = (key: SessionKey) => {
  const database: Layer.Layer<
    Database,
    DatabaseOpenFailed,
    ProjectDatabases | Layer.Services<ReturnType<typeof databaseLayer>>
  > =
    key.open.transcriptMode?.kind === 'ephemeral'
      ? databaseLayer('ephemeral')
      : Layer.effect(
          Database,
          Effect.flatMap(ProjectDatabases, (databases) =>
            RcMap.get(databases, key.storage),
          ),
        );
  return ownerLiveness.pipe(
    Layer.provideMerge(SessionViewService.layer),
    Layer.provideMerge(sessionInputsLayer),
    Layer.provideMerge(sessionEventsLayer.pipe(Layer.provideMerge(database))),
    Layer.provideMerge(
      Layer.mergeAll(
        LocalRuntimeSource.layer,
        TextChunkSource.layer,
        TranscriptSubscriptions.layer,
      ),
    ),
    Layer.provide(Layer.succeed(WorkspaceRoots)(key.open.roots)),
  );
};

/**
 * One session per root, held by the map until `close` releases it or the
 * runtime goes. Opens borrow (released at once) and the idle lifetime is
 * infinite, so the application, never a reader's detachment, ends a session
 * (PR #11893, §3). Entries are `Layer.fresh`, else roots share one fold.
 */
class SessionMap extends Context.Service<
  SessionMap,
  LayerMap.LayerMap<
    SessionKey,
    Session,
    DatabaseOpenFailed | DatabaseReadFailed
  >
>()('@texra/session/SessionMap') {
  static readonly layer = Layer.effect(
    SessionMap,
    Effect.suspend(() => {
      // This composition: each entry holds its root under it while it lives.
      const holder = {};
      return LayerMap.make(
        (key: SessionKey) =>
          Layer.fresh(
            sessionHandleLayer(key).pipe(
              Layer.provide(sessionGraphLayer(key)),
              Layer.provide(
                Layer.effectDiscard(holdProcessRoot(key.storage, holder)),
              ),
            ),
          ),
        { idleTimeToLive: Duration.infinity },
      );
    }),
  );
}

/** The session of `open`'s root: built now, or the one already open. A
 *  build that fails leaves no entry behind (the map would otherwise answer
 *  every later open of the root with the cached failure). */
const openSession = (open: SessionHandleInit) =>
  Effect.gen(function* () {
    const sessions = yield* SessionMap;
    // The map keys and releases a session by this root, so a caller's
    // mutable or inherited root record may not change it later. Read the
    // structural fields so inherited or non-enumerable getters work too.
    const { roots } = open;
    const key = new SessionKey({
      ...open,
      roots: {
        host: roots.host,
        workspace: roots.workspace,
        storage: roots.storage,
        globalStorage: roots.globalStorage,
        config: roots.config,
        workspaceState: roots.workspaceState,
        repoState: roots.repoState,
        globalState: roots.globalState,
      },
    });
    const context = yield* sessions
      .contextEffect(key)
      .pipe(Effect.onError(() => sessions.invalidate(key)));
    // Read once held, so racing first opens agree: the other store refused.
    const store = (init: SessionHandleInit) => init.transcriptMode?.kind;
    for (const held of yield* RcMap.keys(sessions.rcMap))
      if (held.storage === key.storage && store(held.open) !== store(open))
        return yield* new SessionOptionsConflict({
          storage: key.storage,
          message: `The session of ${key.storage} is already open over the other store; close it before opening it differently.`,
        });
    return Context.get(context, Session);
  }).pipe(Effect.scoped);

/** Every session the map holds, entries still building waited for within
 *  the close budget. Builds nothing: a key whose entry has been released,
 *  or is still opening past the budget, is skipped. */
const listSessions = Effect.gen(function* () {
  const sessions = yield* SessionMap;
  const keys = yield* RcMap.keys(sessions.rcMap);
  const held: SessionHandle[] = [];
  for (const key of keys) {
    const entry = yield* sessions.contextEffectOption(key).pipe(
      Effect.scoped,
      Effect.catch(unopenedEntry(key)),
      // A store that will not open must not hold a shutdown: past the
      // close budget the entry is skipped, said once, and released with
      // the map.
      Effect.timeoutOption(SESSION_CLOSE_DEADLINE_MS),
      Effect.flatMap((built) =>
        Option.isSome(built)
          ? Effect.succeed(built.value)
          : Effect.logWarning(
              `Session ${key.storage} was still opening past the close budget; it is skipped here and released with the process.`,
            ).pipe(withLogChannel(CHANNEL), Effect.as(Option.none())),
      ),
    );
    if (Option.isSome(entry)) held.push(Context.get(entry.value, Session));
  }
  return held;
});

/** An entry whose build failed holds no session: its opener fails with the
 *  cause, and a reader that only waited on the entry reads it as absent,
 *  with the cause logged. */
const unopenedEntry =
  (key: SessionKey) =>
  (error: SessionOpenError): Effect.Effect<Option.Option<never>> =>
    logFailure(`Session ${key.storage} failed to open; it holds no session.`)(
      error,
    ).pipe(Effect.as(Option.none()));

/** The session held for `root`, if the map holds one: an entry still building
 *  is waited for, never skipped, which is what lets a close issued right after
 *  an open find the session (`SessionOwner.open`). Builds nothing. */
const heldSession = (root: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionMap;
    const keys = yield* RcMap.keys(sessions.rcMap);
    const key = [...keys].find((candidate) => candidate.storage === root);
    if (key === undefined) return undefined;
    const held = yield* sessions
      .contextEffectOption(key)
      .pipe(Effect.scoped, Effect.catch(unopenedEntry(key)));
    if (Option.isNone(held)) return undefined;
    const session = Context.get(held.value, Session);
    return { key, session, runs: registryOf(session.runs) };
  });

/**
 * Settle one run from outside its driver: what a close does for a run still
 * live when its budget ran out. Its end is ownerless (CANCELLED unless its
 * driver already wrote one), with its checkpoint kept, since a cancelled
 * run is exactly the one a user resumes. A failure is logged, never
 * raised: a later launch classifies the run from its checkpoint.
 */
const settleRun = (session: SessionHandle, runId: RunId): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!(yield* session.log.owns(runId))) return;
    yield* endRunOutsideLifecycle(
      session,
      runId,
      RUN_OUTCOME.CANCELLED,
      undefined,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `Failed to settle run ${runId} as its session closed; a later launch classifies it from its checkpoint`,
      ).pipe(
        Effect.annotateLogs({ data: Cause.squash(cause) }),
        withLogChannel(CHANNEL),
      ),
    ),
  );

/**
 * Close the session of one root, the one way a session ends: refuse new
 * runs; stop every run, cascading, settling the undriven and waiting for the
 * rest ({@link SESSION_CLOSE_DEADLINE_MS}); settle in a second budget each
 * run still held ({@link settleRun}), reported abandoned; release the entry,
 * whose finalizers flush and unwind. Uninterruptible: the budget is its one
 * cancellation, and every step after it still runs.
 */
const closeSession = (root: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionMap;
    const held = yield* heldSession(root);
    // A root with nothing open: nothing to settle, nothing abandoned.
    if (held === undefined)
      return { settled: true, abandoned: [] } satisfies SessionCloseReport;
    const { key, session, runs } = held;
    // A run the stop reached no driver for, or whose stop failed, is settled
    // now rather than waited out; the rest drain, none admitted meanwhile.
    const drained = yield* Effect.gen(function* () {
      const undriven = yield* runs.stopAll();
      for (const runId of undriven) {
        yield* settleRun(session, runId);
        const handle = runs.get(runId)?.handle;
        if (handle) runs.untrackIfCurrent(handle);
      }
      yield* runs.awaitDrained();
    }).pipe(
      Effect.interruptible,
      Effect.timeoutOption(SESSION_CLOSE_DEADLINE_MS),
    );
    const settled = Option.isSome(drained);
    const abandoned = settled ? [] : runs.get().map((run) => run.runId);
    if (abandoned.length > 0) {
      yield* Effect.logWarning(
        `Session ${root} closed with runs still live past its budget; settling them from the close: ${abandoned.join(', ')}`,
      ).pipe(withLogChannel(CHANNEL));
      // The settlement has a budget of its own: a store too stuck to take
      // the terminal rows must not hold the process's exit. A run left
      // unsettled is classified from its checkpoint by the next launch.
      const settledLate = yield* Effect.forEach(
        abandoned,
        (runId) => settleRun(session, runId),
        { discard: true },
      ).pipe(
        Effect.interruptible,
        Effect.timeoutOption(SESSION_CLOSE_DEADLINE_MS),
      );
      if (Option.isNone(settledLate))
        yield* Effect.logWarning(
          `Session ${root} could not settle its abandoned runs within the close budget; the next launch classifies them from their checkpoints`,
        ).pipe(withLogChannel(CHANNEL));
    }
    yield* sessions.invalidate(key);
    return { settled, abandoned } satisfies SessionCloseReport;
  }).pipe(Effect.uninterruptible);

/**
 * What a composition root composes its process from: the app's plugins and
 * setting rows and the host's own ports. What every host builds the same
 * way (the process identity, the global root's database) has a default.
 */
export interface ProcessLayerOptions {
  /** The process-start read the process identity is derived from, once per
   *  process: absent, this Node process's own (`nodeProcesses.selfIdentity`). */
  readonly processStart?: Effect.Effect<
    string | undefined,
    never,
    ProcessProbe
  >;
  /** The global storage root every session of the process shares. */
  readonly globalStorage: string;
  /**
   * The app's plugins, in order, the harness's built-ins among them: the
   * process serves them as `ToolRegistry` and the tool catalog over it
   * (`ToolCatalog`). The harness names no plugin of its own: an app passes
   * its list, `harnessBuiltins` among it.
   */
  readonly plugins: readonly Plugin[];
  /** The MCP config file (`.mcp.json` shape) the catalog reads. */
  readonly mcpConfigPath: string;
  readonly secrets: PlatformSecrets;
  /** The host's agent-directory layer: it may capture AppState as it is
   *  built, which its readers never see. */
  readonly agentDirectories: Layer.Layer<AgentDirectories, never, AppState>;
  /** The host's tool-missing reporter, served as `ToolMissingReporter`;
   *  absent (no UI for it), a probe still answers, without surfacing. */
  readonly toolMissingReporter?: ToolMissingHandler;
  /**
   * The host's global application-state layer, acquired in this runtime's
   * scope: the TeXRA hosts' store over the global root's database values,
   * the SDK's embedder store, or a platform-less CLI entry's refusing one,
   * which creates no storage on a possibly read-only root.
   */
  readonly appState: Layer.Layer<
    AppState,
    DatabaseOpenFailed,
    GlobalDatabase | ProcessIdentity | ProcessProbe
  >;
  /**
   * The host's editor language-model bridge, served as `LanguageModel`. Every
   * host has a value for it: the VS Code extension's bridge to the editor's
   * language-model API, or `UNAVAILABLE_LANGUAGE_MODEL_PORT` elsewhere, where
   * discovery discovers nothing and binding an editor model fails.
   */
  readonly languageModel: LanguageModelPort;
  /** The dependency probes every tool gate and Tools dashboard read: absent,
   *  every host's; a test harness passes one that starts no probe. */
  readonly toolAvailability?: typeof toolAvailabilityLayer;
  /** The host's usage layer owns its version-stamped sender and final drain.
   *  Absent, `UsageLog.disabled`: no usage is reported, as for an embedder,
   *  which has no version or editor of its own to stamp entries with. The
   *  host supplies the layer so this composition does not reach into
   *  telemetry. */
  readonly usageLog?: Layer.Layer<
    UsageLog,
    never,
    HttpClient.HttpClient | AppState
  >;
  /** The process's handle on the global storage root, built and closed with
   *  this runtime. Absent, the root's own database; opening it creates the
   *  root's SQLite file and forks a change poll, so the CLI entry that runs
   *  before any platform, on a possibly read-only root, passes a refusal. */
  readonly globalDatabase?: Layer.Layer<
    GlobalDatabase,
    DatabaseOpenFailed,
    ProcessIdentity | ProcessProbe
  >;
  /**
   * The runtime's emission threshold for Effect diagnostics, from facts that
   * cannot change mid-process: the surface (the extension's channel filters
   * itself: `'Trace'`; the desktop's log file: `'Debug'`) or the CLI's
   * `--quiet` / `--verbose`. It is read before any logger runs, so a live
   * user setting arrives by another road (the fold's `debug` flag).
   */
  readonly minimumLogLevel: MinimumLogLevel;
  /** A single-project host's folder, whose `.env` its own reads see. */
  readonly workspace?: string;
}

/** The process services and the {@link SessionOwner} over the session map
 *  (one session per storage root), which the public `processLayer` serves
 *  its `Sessions` over. */
export function ownerProcessLayer({
  processStart = nodeProcesses.selfIdentity(),
  globalStorage,
  plugins,
  mcpConfigPath,
  secrets,
  appState,
  languageModel,
  agentDirectories,
  toolMissingReporter,
  toolAvailability = toolAvailabilityLayer,
  usageLog = UsageLog.disabled,
  globalDatabase: globalDatabaseOption = globalDatabaseLayer(globalStorage),
  minimumLogLevel,
  workspace,
}: ProcessLayerOptions): Layer.Layer<ProcessServices | SessionOwner> {
  const catalog = pluginCatalogLayer(plugins, mcpConfigPath);
  // Non-failing: `selfIdentity()` reads an unreadable identity as undefined.
  const identity = Layer.effect(
    ProcessIdentity,
    Effect.map(processStart, (start) => ({ ownerId: processOwnerId(start) })),
  );
  // Keep the global handle outside session `Layer.fresh`; open failure is fatal.
  const globalDatabase = globalDatabaseOption.pipe(
    Layer.provide(identity),
    Layer.orDie,
  );
  const services = Layer.mergeAll(
    Secrets.layer(secrets),
    LanguageModel.layer(languageModel),
    // The follower registers each plugin's agent directory off the catalog.
    Layer.provideMerge(
      agentCatalogFollower,
      Layer.merge(agentDirectories, catalog),
    ),
    toolMissingReporter === undefined
      ? Layer.empty
      : ToolMissingReporter.layer(toolMissingReporter),
    catalog,
    // One retry gate for the process: a 429 cools a credential for every
    // project's runs.
    Layer.effect(RouteRetries, ModelRetryGate.make),
  ).pipe(
    Layer.provideMerge(appState.pipe(Layer.orDie)),
    Layer.provideMerge(identity),
  );
  return sessionOwnerLayer.pipe(
    Layer.provideMerge(SessionMap.layer),
    Layer.provideMerge(projectDatabaseLayer),
    // The usage log's own lifetime: its sender and ticker run with this
    // runtime, its finalizer drains the queue while HTTP is up, and it is
    // ahead of `services` so HTTP reaches it.
    Layer.provideMerge(usageLog),
    // Its probes read the plugins' layers and the services below.
    Layer.provideMerge(toolAvailability),
    Layer.provideMerge(services),
    // Every session shares this process's global-storage view.
    Layer.provideMerge(globalStorageFsLayer(globalStorage)),
    // The records' handle on that same root, for the same reason: one
    // connection and one change poll per process, outside the entry.
    Layer.provideMerge(globalDatabase),
    Layer.provideMerge(
      Layer.mergeAll(
        effectDiagnosticsLayer(minimumLogLevel),
        FetchHttpClient.layer,
        Layer.succeed(HttpClient.TracerPropagationEnabled)(false), // no run trace ids to third parties
        // Filesystem, path, spawner, env config: once per process.
        nodePlatformServices,
        workspaceEnvironmentLayer(workspace),
      ),
    ),
  );
}

/**
 * The owner over the map: each method runs on its caller's fiber with the
 * map provided. Its release closes what is still open, plugins drained
 * first, before the map's own release unwinds the entries.
 */
const sessionOwnerLayer = Layer.effect(
  SessionOwner,
  Effect.gen(function* () {
    const map = yield* SessionMap;
    const catalog = yield* ToolCatalog;
    const withMap = <A, E>(
      effect: Effect.Effect<A, E, SessionMap>,
    ): Effect.Effect<A, E> => Effect.provideService(effect, SessionMap, map);
    const closeAll = Effect.gen(function* () {
      // What a plugin admitted for a session (a GitHub poll round's
      // delivery) lands before that session closes, not after.
      yield* catalog.drain;
      return yield* Effect.forEach(
        yield* listSessions,
        (session) => closeSession(session.roots.storage),
        { concurrency: 'unbounded' },
      );
    }).pipe(withMap);
    yield* Effect.addFinalizer(() => Effect.asVoid(closeAll));
    return {
      open: (init) => withMap(openSession(init)),
      list: withMap(listSessions),
      holds: (session) =>
        withMap(heldSession(session.roots.storage)).pipe(
          Effect.map((held) => held?.session === session),
        ),
      close: (root) => withMap(closeSession(root)),
      closeAll,
    };
  }),
);
