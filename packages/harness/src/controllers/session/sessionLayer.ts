/**
 * {@link ownerProcessLayer}: the process services and the `SessionOwner` over
 * a `LayerMap` of sessions, one per storage root, each entry the root-scoped
 * graph and the session's owners over it, each served as its own service.
 * Two opens of a root return one session; an open borrows, `close` settles
 * and releases, and the layer's release closes whatever is still open.
 */
import {
  Context,
  Duration,
  Effect,
  Equal,
  FileSystem,
  Hash,
  Layer,
  LayerMap,
  type LogLevel,
  Option,
  Path,
  RcMap,
} from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import { makeRetryGate, RouteRetries } from '@agent/runtime/ModelRetryGate';
import { SessionOwner, type SessionServices } from '@agent/runtime/rootLaunch';
import {
  SESSION_CLOSE_DEADLINE_MS,
  sessionEventsLayer,
} from '@agent/runtime/sessionEventsLayer';
import type { RunServices } from '@agent/runtime/ToolServices';
import type { SessionHandleInit } from '@agent/runtime/SessionHandle';
import { mcpConfigPathOf } from '@common/plugins/mcpServers';
import { withLogChannel } from '@logger/effectLog';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { AppSignals } from '@platform/appSignals';
import { AgentDirectories, AppState } from '@platform/interfaces';
import { globalStorageFsLayer, SessionRoots } from '@platform/rootedFs';
import type { Secrets } from '@platform/secrets';
import type { SubscriptionAccounts } from '@texra-ai/llm/node';
import {
  processStartIdentity,
  processOwnerId,
} from '@platform/defaults/nodeProcesses';
import { workspaceEnvironmentLayer } from '@platform/defaults/nodePlatform';
import { resolveGlobalStoragePath } from '@platform/defaults/workspaceStorage';
import type { SessionCloseReport } from '@shared/schemas';
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
import type { SettingsCatalog } from '@shared/state/stateSettings';
import { UsageLog } from '@shared/usageLog';
import { ToolCatalogOwner, type ToolCatalog } from '@tools/liveTools';
import { pluginCatalogLayer } from '@tools/pluginCatalog';
import type { Plugin } from '@tools/plugins';
import type { ToolTable } from '@tools/toolTable';
import { toolAvailabilityLayer } from '@tools/toolAvailability';
import { agentCatalogFollower } from '@tools/agentCatalogFollower';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import { databaseLayer, globalDatabaseLayer } from './databaseLayer';
import { processStoresLayer } from './appStateStore';
import { projectDatabaseLayer } from './projectDatabase';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from './sessionSources';
import { SessionViewService } from './sessionViewService';
import { sessionOwnersLayer, stopSessionRuns } from './sessionOwners';
import { sessionInputsLayer } from './sessionInputsLayer';
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
 * and nothing store-bound is injected past that.
 */
class SessionKey implements Equal.Equal {
  readonly open: SessionHandleInit;
  constructor(open: SessionHandleInit) {
    this.open = open;
  }

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

/** The runtime graph of one root: the root-scoped services the
 *  session's owners are built over. */
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
  return SessionViewService.layer.pipe(
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
 * infinite, so the application, never a reader's detachment, ends a session.
 * Entries are `Layer.fresh`, else roots share one fold.
 */
class SessionMap extends Context.Service<
  SessionMap,
  LayerMap.LayerMap<
    SessionKey,
    SessionServices,
    DatabaseOpenFailed | DatabaseReadFailed
  >
>()('@texra-ai/harness/session/SessionMap') {
  static readonly layer = Layer.effect(
    SessionMap,
    Effect.suspend(() => {
      return LayerMap.make(
        (key: SessionKey) =>
          Layer.fresh(
            sessionOwnersLayer(key.open).pipe(
              Layer.provide(sessionGraphLayer(key)),
            ),
          ),
        { idleTimeToLive: Duration.infinity },
      );
    }),
  );
}

/** One lane per root for {@link openSession} and {@link closeSession}: a
 *  close holds the map entry for its one close budget, and an open landing
 *  meanwhile took that entry, then held a session the close shut under it. */
const rootLanes = new Map<string, PerKeyLane>();

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
        workspace: roots.workspace,
        storageRoot: roots.storageRoot,
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
    return context;
  }).pipe(Effect.scoped, withPerKeyLane(rootLanes, open.roots.storage));

/** Every session the map holds, entries still building waited for at once
 *  within the close budget; one released, or opening past it, is skipped. */
const listSessions = Effect.gen(function* () {
  const sessions = yield* SessionMap;
  const entries = yield* Effect.forEach(
    yield* RcMap.keys(sessions.rcMap),
    (key) =>
      sessions.contextEffectOption(key).pipe(
        Effect.scoped,
        Effect.catch(unopenedEntry(key)),
        // A store that will not open must not hold a shutdown: past the
        // close budget the entry is skipped, said once, and released with
        // the map.
        Effect.timeoutOrElse({
          duration: SESSION_CLOSE_DEADLINE_MS,
          orElse: () =>
            Effect.logWarning(
              `Session ${key.storage} was still opening past the close budget; it is skipped here and released with the process.`,
            ).pipe(withLogChannel(CHANNEL), Effect.as(Option.none())),
        }),
      ),
    { concurrency: 'unbounded' },
  );
  return entries.flatMap(Option.toArray);
});

/** An entry whose build failed holds no session: its opener fails with the
 *  cause; a reader that only waited on it reads it as absent, cause logged. */
const unopenedEntry =
  (key: SessionKey) =>
  (error: SessionOpenError): Effect.Effect<Option.Option<never>> =>
    logFailure(`Session ${key.storage} failed to open; it holds no session.`)(
      error,
    ).pipe(Effect.as(Option.none()));

/** The session held for `root`, if the map holds one: an entry still building
 *  is waited for, never skipped, which is what lets a close issued right after
 *  an open find the session (`SessionOwner.open`). Builds nothing. */
const heldSession = Effect.fn('heldSession')(function* (root: string) {
  const sessions = yield* SessionMap;
  const keys = yield* RcMap.keys(sessions.rcMap);
  const key = [...keys].find((candidate) => candidate.storage === root);
  if (key === undefined) return undefined;
  const held = yield* sessions
    .contextEffectOption(key)
    .pipe(Effect.scoped, Effect.catch(unopenedEntry(key)));
  if (Option.isNone(held)) return undefined;
  return { key, session: held.value };
});

/**
 * Close the session of one root, the one way a session ends: refuse new
 * runs; stop every run, cascading, and wait for them to end within its
 * budget ({@link SESSION_CLOSE_DEADLINE_MS}); release the entry, whose
 * finalizers flush and unwind. A shutdown writes no end of its own: a run
 * still live past the budget is reported abandoned and left resumable, its
 * state classified from its checkpoint by the next launch. Uninterruptible:
 * the budget is its one cancellation, and every step after it still runs. */
const closeSession = (root: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionMap;
    const held = yield* heldSession(root);
    // A root with nothing open: nothing to settle, nothing abandoned.
    if (held === undefined)
      return { settled: true, abandoned: [] } satisfies SessionCloseReport;
    const { settled, abandoned } = yield* stopSessionRuns(held.session);
    if (abandoned.length > 0)
      yield* Effect.logWarning(
        `Session ${root} closed with runs still live past its budget; the next launch classifies them from their checkpoints: ${abandoned.join(', ')}`,
      ).pipe(withLogChannel(CHANNEL));
    yield* sessions.invalidate(held.key);
    return { settled, abandoned } satisfies SessionCloseReport;
  }).pipe(Effect.uninterruptible, withPerKeyLane(rootLanes, root));

/** What the process services are composed from: the app's plugins and the
 *  host's own ports; what every host builds the same way (the process
 *  identity, the global root's database) has a default. */
export interface ProcessServicesOptions {
  /** The storage root this process opened (`WorkspaceRoots.storageRoot`). */
  readonly storageRoot: string;
  /** The config's catalog: the state stores key rows under its namespace. */
  readonly settings: SettingsCatalog;
  /**
   * The app's plugins, in order, `harnessBuiltins` among them (the harness
   * names no plugin of its own): the process serves them as `ToolRegistry`
   * and the tool catalog over it (`ToolCatalog`).
   */
  readonly plugins: readonly Plugin[];
  /** The process's store and the subscription accounts over it
   *  (`Secrets.layer`, `Secrets.announcing`). */
  readonly secrets: Layer.Layer<
    Secrets | SubscriptionAccounts,
    never,
    AppSignals
  >;
  /** The host's agent-directory layer: it may capture AppState as it is
   *  built, which its readers never see. */
  readonly agentDirectories: Layer.Layer<AgentDirectories, never, AppState>;
  /** The global application-state layer, acquired in this runtime's scope
   *  (`processLayer` picks the host's and seeds it). */
  readonly appState: Layer.Layer<AppState, DatabaseOpenFailed, GlobalDatabase>;
  /** The dependency probes every tool gate and Tools dashboard read. Hosts
   *  leave it absent; only the repository's test kernel passes one, which
   *  starts no probe, so a suite does not see what the machine installed. */
  readonly toolAvailability?: typeof toolAvailabilityLayer;
  /** The host's usage layer owns its version-stamped sender and final drain,
   *  so this composition does not reach into telemetry. Absent,
   *  `UsageLog.disabled`: no usage is reported, as for an embedder, which
   *  has no version or editor of its own to stamp entries with. */
  readonly usageLog?: Layer.Layer<
    UsageLog,
    never,
    HttpClient.HttpClient | AppState
  >;
  /** The runtime's emission threshold for Effect diagnostics, from facts that
   *  cannot change mid-process: the surface (the extension's channel filters
   *  itself: `'Trace'`; the desktop's log file: `'Debug'`) or the CLI's
   *  `--quiet` / `--verbose`; no live setting changes it. Absent (an
   *  embedder), no logger, level or tracer is installed: its own decide. */
  readonly minimumLogLevel?: LogLevel.LogLevel;
  /** A single-project host's folder, whose `.env` its own reads see. */
  readonly workspace?: string;
}

/** The Node standard-library services a process is built over
 *  (`nodePlatformServices` in a host; a suite may script the spawner). */
export type NodeServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner;

/** The process services and the {@link SessionOwner} over the session map
 *  (one session per storage root), which the public `processLayer` serves
 *  its `Sessions` over, with the project stores and the process's identity
 *  that its cold reads take; `processLayer`'s type serves neither. The
 *  table is the one that composition validated. The filesystem, path and
 *  child-process spawner are whoever builds the layer's, served on to every
 *  session and run. */
export function ownerProcessLayer(
  {
    storageRoot,
    settings,
    secrets,
    appState,
    agentDirectories,
    toolAvailability = toolAvailabilityLayer,
    usageLog = UsageLog.disabled,
    minimumLogLevel,
    workspace,
  }: Omit<ProcessServicesOptions, 'plugins'>,
  table: ToolTable,
): Layer.Layer<
  RunServices | ToolCatalog | SessionOwner | ProjectDatabases | ProcessIdentity,
  never,
  NodeServices
> {
  const globalStorage = resolveGlobalStoragePath(storageRoot);
  const catalog = pluginCatalogLayer(table, mcpConfigPathOf(storageRoot));
  // Read once per build; an unreadable identity is undefined.
  const identity = Layer.unwrap(
    Effect.map(processStartIdentity, (s) =>
      ProcessIdentity.layer(processOwnerId(s)),
    ),
  );
  // Keep the global handle outside session `Layer.fresh`; open failure is fatal.
  const globalDatabase = globalDatabaseLayer(globalStorage).pipe(
    Layer.provide(identity),
    Layer.orDie,
  );
  const services = Layer.mergeAll(
    secrets,
    // The follower registers each plugin's agent directory off the catalog.
    Layer.provideMerge(
      agentCatalogFollower,
      Layer.merge(agentDirectories, catalog),
    ),
    catalog,
    // One retry gate per process: a 429 cools a credential for every project.
    Layer.sync(RouteRetries, makeRetryGate),
  ).pipe(
    Layer.provideMerge(appState.pipe(Layer.orDie)),
    Layer.provideMerge(Layer.merge(identity, AppSignals.layer)),
  );
  return sessionOwnerLayer.pipe(
    Layer.provideMerge(SessionMap.layer),
    Layer.provideMerge(processStoresLayer(settings)),
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
        minimumLogLevel ? effectDiagnosticsLayer(minimumLogLevel) : Layer.empty,
        FetchHttpClient.layer,
        Layer.succeed(HttpClient.TracerPropagationEnabled)(false), // no run trace ids to third parties
        // The builder's filesystem, path and spawner, once per process.
        Layer.effectContext(
          Effect.map(
            Effect.context<NodeServices>(),
            Context.pick(FileSystem.FileSystem, Path.Path, ChildProcessSpawner),
          ),
        ),
        workspaceEnvironmentLayer(workspace),
      ),
    ),
  );
}

/**
 * The owner over the map: each method runs on its caller's fiber with the
 * map provided. A close, of one session or of all, drains the plugins
 * first: what a plugin admitted for a session (a GitHub poll round's
 * delivery) lands before that session closes, not after. Its release
 * closes what is still open before the map's own release unwinds the
 * entries.
 */
const sessionOwnerLayer = Layer.effect(
  SessionOwner,
  Effect.gen(function* () {
    const map = yield* SessionMap;
    const catalog = yield* ToolCatalogOwner;
    const withMap = <A, E>(
      effect: Effect.Effect<A, E, SessionMap>,
    ): Effect.Effect<A, E> => Effect.provideService(effect, SessionMap, map);
    const closeAll = Effect.gen(function* () {
      yield* catalog.drain;
      return yield* Effect.forEach(
        yield* listSessions,
        (session) => closeSession(Context.get(session, SessionRoots).storage),
        { concurrency: 'unbounded' },
      );
    }).pipe(withMap);
    yield* Effect.addFinalizer(() => Effect.asVoid(closeAll));
    return {
      open: (init) => withMap(openSession(init)),
      list: withMap(listSessions),
      close: (root) =>
        withMap(Effect.andThen(catalog.drain, closeSession(root))),
      closeAll,
    };
  }),
);
