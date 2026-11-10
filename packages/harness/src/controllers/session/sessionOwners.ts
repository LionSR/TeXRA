/**
 * One session's services, built by one scoped program over the root's
 * graph (`sessionLayer.ts` builds that graph and holds the session in its
 * map): the store, the view, the project's side, the inbox, the
 * presentation host, the approvals, the requests, the child-run budget,
 * the runs, whose fork captures every service built before them, and what
 * reads the session as it runs. Acquired in that order; the scope releases
 * them in reverse, so the runs go first and the store's doors last.
 */
import {
  Cause,
  Clock,
  Context,
  Effect,
  FiberMap,
  FiberSet,
  Layer,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';

import { Inbox, SessionInbox } from '@agent/followUp/Inbox';
import { wakeIfOwed } from '@agent/followUp/ToolUseFollowUp';
import {
  ChildRunBudget,
  resolveChildRunConcurrencyBudget,
} from '@agent/runtime/childRunBudget';
import { executeAgent } from '@agent/runtime/executeAgent';
import {
  Interactions,
  presentTerminalResult,
} from '@agent/runtime/HostInteractions';
import { HistoryQueryStore } from '@agent/runtime/historyQuery/HistoryQuery';
import { sessionApprovals } from '@agent/runtime/runApprovalQueue';
import { SessionRequests, sessionPermission } from '@agent/runtime/requests';
import { ProjectTools } from '@agent/runtime/loop/step';
import { makeRunHistory } from '@agent/runtime/makeRunHistory';
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
import { SESSION_CLOSE_DEADLINE_MS } from '@agent/runtime/sessionEventsLayer';
import { withLogChannel } from '@logger/effectLog';
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
import { ToolCatalogOwner } from '@tools/liveTools';
import { announceWrites, factKindsOf } from '@tools/plugins';
import { ToolAvailability } from '@tools/toolAvailabilityService';
import { ToolRegistry } from '@tools/toolTable';
import { deletionCollector } from './deletionCleanup';
import { sessionRequests } from './SessionRequests';
import { makeSessionStore } from './sessionStore';
import {
  LocalRuntimeSource,
  type TextChunkSource,
  type TranscriptSubscriptions,
} from './sessionSources';
import {
  makeSessionViewAccess,
  type SessionViewService,
} from './sessionViewService';
import { sweepLeftoverRuns } from './sweepLeftoverRuns';

const CHANNEL = 'sessionOwners';

/** Log a failure on this channel, with the failure attached as its `data`. */
const logFailure =
  (message: string, log = Effect.logWarning) =>
  (data: unknown) =>
    log(message).pipe(Effect.annotateLogs({ data }), withLogChannel(CHANNEL));

/** Stop every run of `session`, cascading, and wait for them to end within
 *  the close budget, which starts before the stop rows: their writes are
 *  durable appends and run whole, and the wait gets what they left of the
 *  budget. The runs still live past it are abandoned. */
export const stopSessionRuns = (
  session: Context.Context<SessionServices>,
): Effect.Effect<SessionCloseReport> =>
  Effect.gen(function* () {
    const runs = registryOf(Context.get(session, Runs));
    const closeBy =
      (yield* Clock.currentTimeMillis) + SESSION_CLOSE_DEADLINE_MS;
    yield* runs.stopAll();
    const left = closeBy - (yield* Clock.currentTimeMillis);
    yield* runs
      .awaitDrained()
      .pipe(Effect.interruptible, Effect.timeoutOption(Math.max(left, 0)));
    const abandoned = runs.get().map((run) => run.runId);
    return { settled: abandoned.length === 0, abandoned };
  });

/**
 * The services of one root over its graph, one scoped program. The entry's
 * scope is the session's one lifetime (`closeSession` and disposal close
 * it): what is acquired later is released earlier, so the runs are
 * disposed before the inbox and the host, the store's publisher drains
 * after the runs' fibers published their last rows, and the readers of its
 * tails, acquired first, live until the end.
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
  Layer.effectContext(
    Effect.gen(function* () {
      const { roots } = open;
      // The readers' scope, closed last so the teardown publishes and
      // settles while the tails and the view live.
      const consumers = yield* Effect.acquireRelease(
        Scope.make(),
        (scope, exit) => Scope.close(scope, exit),
      );
      // The store: the session's one publisher, and its doors past the log.
      const store = yield* makeSessionStore(roots.storage);
      const deletions = yield* deletionCollector(
        yield* Database,
        roots.storage,
      );
      const view = yield* makeSessionViewAccess(roots.storage, store.closed);
      // The publisher drains inside the close deadline, after the runs'
      // fibers published their last rows.
      yield* Effect.addFinalizer(() => store.close);
      // The runs' fibers (one per run, under its id) and the session's own,
      // interrupted after the services above them are disposed and before
      // the publisher drains.
      const runFibers = yield* FiberMap.make<RunId>();
      const fibers = yield* FiberSet.make();

      // The project's side: its tools, its history store, its run history
      // over the log, and its roots with the rooted filesystems over them.
      const tools = yield* (yield* ToolCatalogOwner).session;
      const log = store.log;
      const history = yield* HistoryQueryStore.make.pipe(
        Effect.provideService(SessionLog, log),
        Effect.provideService(SessionViewAccess, view),
      );
      const project = Context.make(SessionLog, log).pipe(
        Context.add(SessionViewAccess, view),
        Context.add(ProjectTools, tools),
        Context.add(HistoryQuery, history),
        Context.add(RunHistory, makeRunHistory(log)),
        Context.add(SessionRoots, roots),
        Context.merge(yield* Layer.build(sessionFsLayer(roots))),
      );

      // The follow-up inbox, over the log and the publisher's detached door,
      // disposed after the runs.
      const inbox = yield* Effect.acquireRelease(
        Effect.sync(() => new SessionInbox({ log, detach: store.detach })),
        (inbox) => Effect.sync(() => inbox.dispose()),
      );
      // The presentation host the session was opened with, which answers
      // while no host is attached; disposed after the runs.
      const interactions = yield* Interactions.make(open.interactions);
      // The approvals, with the one reading of the policy over the host.
      const approvals = yield* sessionApprovals.pipe(Effect.provide(project));
      const withPolicy = project.pipe(
        Context.add(Inbox, inbox),
        Context.add(Interactions, interactions),
        Context.add(Approvals, {
          ...approvals,
          permission: sessionPermission(approvals, interactions),
        }),
      );
      // The requests, over the store's removal door: a committed removal's
      // local half (the inbox forgets its runs) and its collection follow
      // from the rows it returns.
      const database = yield* Database;
      const requests = sessionRequests({
        sessionLog: log,
        view,
        log: {
          aggregateState: database.aggregateState,
          removeRun: (id, expectedStartCommit) =>
            Effect.tap(store.removeRun(id, expectedStartCommit), (rows) =>
              Effect.sync(() => {
                for (const row of rows) {
                  if (row.type !== 'run.removed') continue;
                  for (const runId of row.runIds) inbox.forget(runId);
                  deletions.removed(row);
                }
              }),
            ),
        },
        plugins: yield* ToolRegistry,
        services: yield* Effect.context<RunServices>(),
      });
      // The child-run budget, sized from the setting at open; a setting
      // that cannot be read leaves the default and says so.
      const budget = yield* resolveChildRunConcurrencyBudget(roots).pipe(
        Effect.map((permits) => Semaphore.makeUnsafe(permits)),
        Effect.catch((error) =>
          logFailure('The child-run budget setting could not be read.')(
            error,
          ).pipe(Effect.as(ChildRunBudget.defaultValue())),
        ),
      );
      const withRequests = withPolicy.pipe(
        Context.add(SessionRequests, requests),
        Context.add(ChildRunBudget, budget),
      );

      // The runs: their fork captures the context built so far, over every
      // service a run reads, one fiber per run under its id. Disposed
      // first, so no run is admitted over a session that is unwinding.
      // The context the runs' forks capture: the process's services and
      // every service built so far.
      const services: Context.Context<Exclude<AgentRunServices, Runs>> =
        Context.merge(yield* Effect.context<RunServices>(), withRequests);
      const fork = yield* FiberSet.runtime(fibers)<
        Exclude<AgentRunServices, Runs>
      >().pipe(Effect.provide(services));
      const forkRun = yield* FiberMap.runtime(runFibers)<
        Exclude<AgentRunServices, Runs>
      >().pipe(Effect.provide(services));
      const local = (yield* LocalRuntimeSource).ref;
      const runs: RunRegistry = new RunRegistry({
        view,
        log,
        // Set, never updated from a read: each call carries the whole set,
        // and the fork runs it before this fiber goes on.
        runsHere: (runIds) =>
          void fork(SubscriptionRef.set(local, { runsHere: [...runIds] })),
        roots,
        inSession: (effect) => Effect.provide(effect, services),
        fork: forkRun,
        programs: { executeAgent, stop: stopRun },
        wake: (id) =>
          void fork(wakeIfOwed(id).pipe(Effect.provideService(Runs, runs))),
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => runs.dispose()));
      const session: Context.Context<SessionServices> = Context.add(
        withRequests,
        Runs,
        runs,
      );

      // What reads the session as it runs: the tails' readers (in the
      // readers' scope), the leftover-run sweep, the deletion pass at open,
      // and the dependency probes, held for its life and probed beside the
      // open (the gate withholds nothing until they answer).
      const plugins = yield* ToolRegistry;
      // The registry's phase notification rides the applied rows: its
      // waiters read `RunView.status` once the view holds a row's state.
      // Host notices go to the author. `log.settled` waits for this reader.
      const announce = announceWrites(factKindsOf(plugins.entries.values()));
      yield* Stream.runForEach(
        store.applied,
        Effect.fnUntraced(function* (event) {
          yield* announce(event);
          if (store.closed()) return;
          yield* presentTerminalResult(event).pipe(
            Effect.provide(session),
            Effect.catchCause((cause) =>
              logFailure('Terminal result presentation threw')(
                Cause.squash(cause),
              ),
            ),
          );
        }),
      ).pipe(Effect.forkIn(consumers));
      yield* sweepLeftoverRuns.pipe(Effect.provide(session), Effect.forkScoped);
      yield* Effect.forkScoped(deletions.pending);
      yield* (yield* ToolAvailability).hold(roots);
      return session;
    }),
  );
