/**
 * One session's owners, each served as its own service over the root's
 * graph (`sessionLayer.ts` builds that graph and holds the session in its
 * map): the store, the project's side, the inbox, the presentation host,
 * the approvals, the requests, the runs, whose fork captures every owner
 * below it, and what reads the session as it runs.
 */
import {
  Cause,
  Context,
  Effect,
  FiberMap,
  FiberSet,
  Layer,
  Option,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import { Inbox, SessionInbox } from '@agent/followUp/Inbox';
import { wakeIfOwed } from '@agent/followUp/ToolUseFollowUp';
import { executeAgent } from '@agent/runtime/executeAgent';
import {
  Interactions,
  presentTerminalResult,
} from '@agent/runtime/HostInteractions';
import { HistoryQueryStore } from '@agent/runtime/historyQuery/HistoryQuery';
import { sessionPermission } from '@agent/runtime/loop/toolGuard';
import { sessionApprovals } from '@agent/runtime/runApprovalQueue';
import { requestAsks, SessionRequests } from '@agent/runtime/requestPolicy';
import { ProjectTools } from '@agent/runtime/loop/step';
import { makeRunHistory } from '@agent/runtime/RunHistory';
import { stopRun } from '@agent/storage/runLifecycle';
import {
  registryOf,
  RunRegistry,
  Runs,
  type AgentRunServices,
} from '@agent/runtime/runRegistry';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import type { SessionHandleInit } from '@agent/runtime/SessionHandle';
import type { RunServices } from '@agent/runtime/ToolServices';
import { SESSION_CLOSE_DEADLINE_MS } from '@agent/runtime/SessionEvents';
import { withLogChannel } from '@logger/effectLog';
import { workspaceEnvironmentLayer } from '@platform/defaults/nodePlatform';
import { SessionRoots, sessionFsLayer } from '@platform/rootedFs';
import type { RunId, SessionCloseReport } from '@shared/schemas';
import { Database, type DatabaseReadFailed } from '@shared/session/database';
import type { SessionInputs } from '@shared/session/sessionInputs';
import {
  Approvals,
  HistoryQuery,
  RunHistory,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import type { SessionEvents } from '@shared/session/sessionEvents';
import { type RunView } from '@shared/session/sessionView';
import { ToolCatalogOwner } from '@tools/liveTools';
import { announceWrites, factKindsOf } from '@tools/plugins';
import { ToolAvailability } from '@tools/toolAvailabilityService';
import { ToolRegistry } from '@tools/toolTable';
import { deletionCollector } from './deletionCleanup';
import { sessionRequests } from './SessionRequests';
import { makeSessionStore, type SessionStore } from './sessionStore';
import {
  LocalRuntimeSource,
  type TextChunkSource,
  type TranscriptSubscriptions,
} from './sessionSources';
import { makeSessionViewAccess, type SessionViewService } from './SessionView';
import { sweepLeftoverRuns } from './sweepLeftoverRuns';

const CHANNEL = 'sessionOwners';

/** Log a failure on this channel, with the failure attached as its `data`. */
const logFailure =
  (message: string, log = Effect.logWarning) =>
  (data: unknown) =>
    log(message).pipe(Effect.annotateLogs({ data }), withLogChannel(CHANNEL));

/**
 * The store, for the owners above it: its doors past the log; the
 * consumers' scope, closed last so the teardown publishes and settles while
 * the tails and the view live; the runs' fibers (one per run, under its id)
 * and the session's own, interrupted after the owners above are disposed
 * and before the publisher drains; the deletion pass; and the startup
 * cohort, read before anyone can launch.
 */
class SessionStoreParts extends Context.Service<
  SessionStoreParts,
  {
    readonly store: SessionStore;
    readonly view: SessionViewAccess['Service'];
    readonly consumers: Scope.Closeable;
    readonly runFibers: FiberMap.FiberMap<RunId>;
    readonly fibers: FiberSet.FiberSet;
    readonly collectDeletions: Effect.Effect<void>;
    readonly cohort: Iterable<RunView>;
  }
>()('@texra-ai/harness/session/SessionStoreParts') {
  static readonly layer = (open: SessionHandleInit) =>
    Layer.effect(
      SessionStoreParts,
      Effect.gen(function* () {
        const consumers = yield* Effect.acquireRelease(
          Scope.make(),
          (scope, exit) => Scope.close(scope, exit),
        );
        const store = yield* makeSessionStore(open.roots.storage);
        const collectDeletions = yield* deletionCollector(
          yield* Database,
          open.roots.storage,
        );
        const view = yield* makeSessionViewAccess(
          open.roots.storage,
          store.closed,
        );
        const cohort = (yield* view.read([])).runs.values();
        // The publisher drains inside the close deadline, after the runs'
        // fibers published their last rows.
        yield* Effect.addFinalizer(() => store.close);
        const runFibers = yield* FiberMap.make<RunId>();
        const fibers = yield* FiberSet.make();
        return {
          store,
          view,
          consumers,
          runFibers,
          fibers,
          collectDeletions,
          cohort,
        };
      }),
    );
}

/** The project's side: its tools, its history store, its run history over
 *  the log, and its roots with the rooted filesystems over them. */
const projectLayer = (open: SessionHandleInit) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const { store, view } = yield* SessionStoreParts;
      const tools = yield* (yield* ToolCatalogOwner).session;
      const history = yield* HistoryQueryStore.make.pipe(
        Effect.provideService(SessionLog, store.log),
        Effect.provideService(SessionViewAccess, view),
      );
      return Context.make(SessionLog, store.log).pipe(
        Context.add(SessionViewAccess, view),
        Context.add(ProjectTools, tools),
        Context.add(HistoryQuery, history),
        Context.add(RunHistory, makeRunHistory(store.log)),
        Context.add(SessionRoots, open.roots),
      );
    }),
  ).pipe(Layer.merge(sessionFsLayer(open.roots)));

/** The session's requests, over its store's removal and detached doors. */
const requestsLayer = Layer.effect(
  SessionRequests,
  Effect.gen(function* () {
    const { store, collectDeletions } = yield* SessionStoreParts;
    const database = yield* Database;
    return sessionRequests({
      asks: yield* requestAsks,
      sessionLog: yield* SessionLog,
      view: yield* SessionViewAccess,
      log: {
        aggregateState: database.aggregateState,
        removeRun: (id, start) =>
          Effect.tap(store.removeRun(id, start), () => collectDeletions),
      },
      plugins: yield* ToolRegistry,
      services: yield* Effect.context<RunServices>(),
    });
  }),
);

/** The session's follow-up inbox, over its log and its publisher, disposed
 *  after its runs. */
const inboxLayer = Layer.effect(
  Inbox,
  Effect.gen(function* () {
    const log = yield* SessionLog;
    const { detach } = (yield* SessionStoreParts).store;
    return yield* Effect.acquireRelease(
      Effect.sync(() => new SessionInbox({ log, detach })),
      (inbox) => Effect.sync(() => inbox.dispose()),
    );
  }),
);

/** The session's runs: their fork captures the context here, over every
 *  owner a run reads, one fiber per run under its id. Disposed first, so
 *  no run is admitted over a session that is unwinding. */
const runsLayer = (open: SessionHandleInit) =>
  Layer.effect(
    Runs,
    Effect.gen(function* () {
      const { fibers, runFibers } = yield* SessionStoreParts;
      const fork =
        yield* FiberSet.runtime(fibers)<Exclude<AgentRunServices, Runs>>();
      const forkRun =
        yield* FiberMap.runtime(runFibers)<Exclude<AgentRunServices, Runs>>();
      // The session's context, as the fork above captures it: what its
      // launches open and run on, whichever fiber asks.
      const services = yield* Effect.context<Exclude<AgentRunServices, Runs>>();
      // Each run's `.env`, read as it launches.
      const env = workspaceEnvironmentLayer(open.roots.workspace);
      const local = (yield* LocalRuntimeSource).ref;
      const runs: RunRegistry = new RunRegistry({
        view: yield* SessionViewAccess,
        log: yield* SessionLog,
        // Set, never updated from a read: each call carries the whole set,
        // and the fork runs it before this fiber goes on.
        runsHere: (runIds) =>
          void fork(SubscriptionRef.set(local, { runsHere: [...runIds] })),
        roots: open.roots,
        inSession: (effect) =>
          Effect.provide(Effect.provide(effect, env), services),
        fork: (runId, run) => forkRun(runId, Effect.provide(run, env)),
        programs: { executeAgent, stop: stopRun },
        wake: (id) =>
          void fork(wakeIfOwed(id).pipe(Effect.provideService(Runs, runs))),
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => runs.dispose()));
      return runs;
    }),
  );

/** What reads the session as it runs: the tails' readers (in the
 *  consumers' scope), the leftover-run sweep, the deletion pass at open,
 *  and the dependency probes, held for its life and
 *  probed beside the open (the gate withholds nothing until they answer). */
const consumersLayer = (open: SessionHandleInit) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { store, consumers, collectDeletions, cohort } =
        yield* SessionStoreParts;
      const inbox = yield* Inbox;
      const plugins = yield* ToolRegistry;
      // The local half of a committed removal; its plugin rows go with it.
      yield* store
        .deliver((runId) => inbox.forget(runId))
        .pipe(Scope.provide(consumers));
      // The registry's phase notification rides the fold-gated tail: its
      // waiters read `RunView.status` once the view holds a row's state.
      // Host notices go to the author. `log.settled` waits for this reader.
      const announce = announceWrites(factKindsOf(plugins.entries.values()));
      yield* Stream.runForEach(
        store.folded,
        Effect.fnUntraced(function* (event) {
          yield* announce(event);
          if (store.closed()) return;
          yield* presentTerminalResult(event).pipe(
            Effect.catchCause((cause) =>
              logFailure('Terminal result presentation threw')(
                Cause.squash(cause),
              ),
            ),
          );
        }),
      ).pipe(
        Effect.catch(
          logFailure(
            `Session ${open.roots.storage} stopped delivering folded rows: the log could not be read.`,
            Effect.logError,
          ),
        ),
        Effect.forkIn(consumers),
      );
      yield* sweepLeftoverRuns(cohort).pipe(Effect.forkScoped);
      yield* collectDeletions;
      yield* (yield* ToolAvailability).hold(open.roots);
    }),
  );

/** Stop every run of `session`, cascading, and wait for them to end within
 *  the close budget: the runs still live past it are abandoned. */
export const stopSessionRuns = (
  session: Context.Context<SessionServices>,
): Effect.Effect<SessionCloseReport> =>
  Effect.gen(function* () {
    const runs = registryOf(Context.get(session, Runs));
    yield* runs.stopAll();
    const drained = yield* runs
      .awaitDrained()
      .pipe(
        Effect.interruptible,
        Effect.timeoutOption(SESSION_CLOSE_DEADLINE_MS),
      );
    const settled = Option.isSome(drained);
    const abandoned = settled ? [] : runs.get().map((run) => run.runId);
    return { settled, abandoned };
  });

/** The session's approvals, with the one reading of its policy
 *  (`sessionPermission`) over its presentation host. */
const approvalsLayer = Layer.effect(
  Approvals,
  Effect.gen(function* () {
    const approvals = yield* sessionApprovals;
    const permission = sessionPermission(approvals, yield* Interactions);
    return { ...approvals, permission };
  }),
);

/**
 * The owners of one root over its graph, each its own service, each over
 * the ones below it. The entry's scope is the session's one lifetime
 * ({@link closeSession} and disposal close it): each layer releases before
 * the ones below, so the runs go first and the store's doors last.
 */
export const sessionOwnersLayer = (
  open: SessionHandleInit,
): Layer.Layer<
  SessionServices,
  DatabaseReadFailed,
  | Database
  | SessionEvents
  | SessionInputs
  | SessionViewService
  | LocalRuntimeSource
  | TextChunkSource
  | TranscriptSubscriptions
  | ToolCatalogOwner
  | RunServices
> =>
  consumersLayer(open).pipe(
    Layer.provideMerge(runsLayer(open)),
    Layer.provideMerge(requestsLayer),
    Layer.provideMerge(approvalsLayer),
    Layer.provideMerge(Interactions.layer(open.interactions)),
    Layer.provideMerge(inboxLayer),
    Layer.provideMerge(projectLayer(open)),
    Layer.provide(SessionStoreParts.layer(open)),
  );
