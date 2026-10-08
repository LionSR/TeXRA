/**
 * The process layer ({@link processLayer}): every process service a
 * composition root runs on, and the `SessionOwner` over the keyed family of
 * sessions, a `LayerMap` keyed by workspace storage root (one session per
 * root and one only). A root's entry is the complete session: the
 * root-scoped services (the database event log, the session event reads and
 * publications, the fold, the session inputs, the three local sources, and
 * the owner-liveness prober) and the `SessionHandle` built over them, whose
 * request handler admits on that graph. Every opener (the hosts' default
 * sessions, the desktop's projects, the service's tasks, the SDK) resolves
 * its root here, so opening a root twice returns one handle, and the map is
 * the one owner of its lifetime: an open borrows, `close` settles and
 * releases, and the layer's release closes whatever is still open.
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
import { AgentEngine } from '@agent/runtime/AgentEngine';
import {
  executeAgent,
  resumeToolUseFromResumeData,
} from '@agent/runtime/executeAgent';
import { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import { HistoryQuery } from '@agent/runtime/historyQuery/HistoryQuery';
import { ModelRetryGate } from '@agent/runtime/ModelRetryGate';
import { RouteRetries } from '@agent/runtime/run/invocation';
import { resumeRun } from '@agent/runtime/resumeRun';
import { createSessionApprovals } from '@agent/runtime/runApprovalQueue';
import { makeRunHistory } from '@agent/runtime/RunHistory';
import { RunRegistry } from '@agent/runtime/runRegistry';
import { sessionEventsLayer } from '@agent/runtime/SessionEvents';
import type {
  SessionHandle,
  SessionHandleInit,
} from '@agent/runtime/SessionHandle';
import { SESSION_CLOSE_DEADLINE_MS } from '@agent/runtime/SessionHandle';
import { presentTerminalResult } from '@agent/runtime/terminalResultToast';
import { withLogChannel } from '@logger/effectLog';
import {
  effectDiagnosticsLayer,
  type MinimumLogLevel,
} from '@logger/effectDiagnostics';
import { SessionOwner } from '@platform/processRuntime';
import type { ProcessServices } from '@platform/processRuntime';
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
  GlobalDatabase,
  type SessionOpenError,
} from '@shared/session/database';
import { UsageLog } from '@shared/usageLog';
import {
  installSettingsCatalog,
  settingsCatalog,
  type StateSettingEntry,
} from '@shared/state/stateSettings';
import { releaseRunResources } from '@tools/approval';
import { LiveTools } from '@tools/liveTools';
import { pluginCatalogLayer } from '@tools/pluginCatalog';
import type { Plugin } from '@tools/plugins';
import { drainPlugins, sessionPluginLayers } from '@tools/pluginLayers';
import { toolAvailabilityLayer } from '@tools/toolAvailability';
import { ToolAvailability } from '@tools/toolAvailabilityService';
import { ToolRegistry } from '@tools/toolTable';
import { agentCatalogFollower } from '@tools/agentCatalogFollower';
import { followInterruptedTasks } from '@tools/interruptedTasks';
import { databaseLayer, globalDatabaseLayer } from './Database';
import { projectDatabaseLayer } from './projectDatabase';
import { deletionCollector } from './deletionCleanup';
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
 * The handle of one root, over the root's graph: the session is the entry's
 * one service. The last layer of the entry, so it is the first thing unwound
 * when the entry closes and the graph outlives every publisher above it. The
 * entry's scope is the session's one lifetime: {@link closeSession} and the
 * runtime's disposal both end it by closing that scope, and every owner the
 * handle holds is torn down by a finalizer registered here.
 */
const sessionHandleLayer = (key: SessionKey) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const database = yield* Database;
      const plugins = yield* ToolRegistry;
      const globalDatabase = yield* GlobalDatabase;
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
      // The runs' fork and the history store end with this scope.
      const fork = yield* FiberSet.makeRuntime<ProcessServices>();
      const pinPlugins = yield* sessionPluginLayers(() => session.runs);
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
        pinPlugins,
      });
      const session: SessionHandle = {
        roots: key.open.roots,
        log: store.log,
        view,
        runs,
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
          globalDatabase,
          closed: store.closed,
        }),
        approvals: createSessionApprovals(() => session),
        interactions,
        followUps: new Inbox({
          log: store.log,
          detach: store.detach,
          parentOf: (runId) => view.run(runId)?.parentId,
          live: (runId) => runs.isLive(runId),
        }),
        trace: store.trace,
        runHistory: makeRunHistory(store.log, database),
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
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => session.runs.dispose()),
      );
      // An opener's presentation host attaches as its own step: `use`
      // replays its queue, a program a constructor cannot run.
      if (key.open.interactions)
        yield* session.interactions.use(key.open.interactions);
      // The local half of a committed removal; its plugin rows go with it.
      yield* store
        .deliver((runId) => {
          session.runs.detachChildren(runId);
          releaseRunResources(runId, session);
        })
        .pipe(Scope.provide(consumerScope));
      // The registry's phase notification rides the fold-gated tail: its
      // waiters read `RunView.status` synchronously, so a row reaches them
      // once the view holds its state. Host notices go to the author.
      yield* Stream.runForEach(store.folded, (event) =>
        Effect.gen(function* () {
          const target = aggregateTarget(event.aggregateId);
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
          session.runs.sweepChildrenOfFoldedStop(target.id);
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
    ProjectDatabases | ProcessIdentity | WorkspaceRoots | ProcessProbe
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
 * The keyed resource family the desktop's N papers and the SDK's N roots need:
 * one session per root, held by the map until `close` releases it or the
 * runtime goes. Opens borrow (the reference an open takes is released at once)
 * and the idle lifetime is infinite, so no reader's detachment and no
 * reference count decides a session's end: the application does, explicitly
 * (PR #11893, agent SDK architecture proposal, section 3). Entries are
 * `Layer.fresh`: layers memoize by reference, else roots share one fold.
 */
class SessionMap extends Context.Service<
  SessionMap,
  LayerMap.LayerMap<SessionKey, Session, SessionOpenError>
>()('@texra/session/SessionMap') {
  static readonly layer = Layer.effect(
    SessionMap,
    LayerMap.make(
      (key: SessionKey) =>
        Layer.fresh(
          sessionHandleLayer(key).pipe(Layer.provide(sessionGraphLayer(key))),
        ),
      { idleTimeToLive: Duration.infinity },
    ),
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
    return { key, session, runs: session.runs };
  });

/**
 * Settle one run from outside its driver: what a close does for a run still
 * live when its budget ran out. Its outcome is recorded — CANCELLED unless
 * its driver already wrote one — in the one batch that also closes the
 * transcript groups it left open, with its checkpoint kept, since a
 * cancelled run is exactly the one a user resumes. A driver that writes a
 * different outcome after this is a separate lifecycle race:
 * `keepExistingOutcome` only protects earlier writes. A failure is logged,
 * never raised: a later launch classifies the run from its checkpoint.
 */
const settleRun = (session: SessionHandle, runId: RunId): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!(yield* session.log.owns(runId))) return;
    const finalization = yield* session.runs.end({
      runId,
      outcome: RUN_OUTCOME.CANCELLED,
      keepExistingOutcome: true,
    });
    if (!finalization.ok) return yield* Effect.die(finalization.error);
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
 * Close the session of one root, the one way a session ends, whoever asks.
 * In order, on the caller's fiber:
 *
 * 1. refuse new runs;
 * 2. stop every run (it cascades into children; a process child's OS
 *    process ends with its loop), settle those no driver answered for, and
 *    wait for the rest, inside one budget ({@link SESSION_CLOSE_DEADLINE_MS});
 * 3. settle from here, inside a second budget, each run still held when the
 *    first runs out ({@link settleRun}), reporting it as abandoned;
 * 4. release the entry, whose finalizers flush the session's publications
 *    and unwind its owners.
 *
 * The whole close is uninterruptible, so the budget is its one cancellation
 * channel: the stop and its wait run interruptible inside it, so the deadline
 * cuts them, and every step after the deadline still runs.
 */
const closeSession = (root: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionMap;
    const held = yield* heldSession(root);
    // A root with nothing open: nothing to settle, nothing abandoned.
    if (held === undefined)
      return { settled: true, abandoned: [] } satisfies SessionCloseReport;
    const { key, session, runs } = held;
    runs.close();
    // A run the stop reached no driver for, or whose stop failed, has nothing
    // to settle it: the close settles it now instead of waiting out the
    // budget for it.
    const drained = yield* Effect.gen(function* () {
      const undriven = yield* runs.stopAll();
      for (const runId of undriven) {
        yield* settleRun(session, runId);
        const handle = runs.getHandle(runId);
        if (handle) runs.untrackIfCurrent(handle);
      }
      yield* runs.awaitDrained();
    }).pipe(
      Effect.interruptible,
      Effect.timeoutOption(SESSION_CLOSE_DEADLINE_MS),
    );
    const settled = Option.isSome(drained);
    const abandoned = settled ? [] : runs.heldIds();
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
   * process serves them as `ToolRegistry` and the live catalog over it
   * (`LiveTools`). The harness names no plugin of its own; TeXRA's entries
   * pass `texraPlugins` (`@tools/registry`).
   */
  readonly plugins: readonly Plugin[];
  /** The app's setting rows (its plugins' among them), installed with the harness's. */
  readonly settings?: readonly StateSettingEntry[];
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
  /**
   * The host's usage layer owns its version-stamped sender and final drain.
   * Absent, `UsageLog.disabled`: no usage is reported, as for an embedder,
   * which has no version or editor of its own to stamp entries with. The
   * host supplies the layer so this composition does not reach into
   * telemetry.
   */
  readonly usageLog?: Layer.Layer<
    UsageLog,
    never,
    HttpClient.HttpClient | AppState
  >;
  /**
   * The process's handle on the global storage root, built and closed with
   * this runtime. Absent, the root's own database; opening it creates the
   * root's SQLite file and forks a change poll, so the CLI entry that runs
   * before any platform, on a possibly read-only root, passes a refusal.
   */
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

/**
 * The process: every process service a composition root runs on, and the
 * {@link SessionOwner} that opens, lists and closes its sessions (one per
 * workspace storage root, held by a `LayerMap`). A host builds it once with
 * `ManagedRuntime.make` and disposes that runtime on its shutdown path; the
 * SDK's `Sessions.layer` provides it to its projection. Disposal closes every
 * session still open (plugins drained first), so a host that needs its
 * sessions closed before its own resources tear down runs
 * `SessionOwner.closeAll` first.
 */
export function processLayer({
  processStart = nodeProcesses.selfIdentity(),
  globalStorage,
  plugins,
  settings = [],
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
  installSettingsCatalog(settingsCatalog(settings));
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
    Layer.succeed(AgentEngine)({
      executeAgent,
      resumeToolUseFromResumeData,
      resumeRun,
    }),
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
    const live = yield* LiveTools;
    const registry = yield* ToolRegistry;
    const withMap = <A, E>(
      effect: Effect.Effect<A, E, SessionMap>,
    ): Effect.Effect<A, E> => Effect.provideService(effect, SessionMap, map);
    const closeAll = Effect.gen(function* () {
      // What a plugin admitted for a session (a GitHub poll round's
      // delivery) lands before that session closes, not after.
      yield* drainPlugins(live).pipe(
        Effect.provideService(ToolRegistry, registry),
      );
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
      close: (root) => withMap(closeSession(root)),
      closeAll,
    };
  }),
);
