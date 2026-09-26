/**
 * The per-session Effect graph and the process's keyed family of them. `Sessions` is a `LayerMap` keyed by
 * workspace storage root: one session per root and one only, built on the one
 * `ManagedRuntime` each process makes at its entry (`installProcessRuntime`).
 * A root's entry is the complete session: the root-scoped services (the
 * database event log, the session event reads and publications, the fold, the
 * session inputs, the three local sources, and the owner-liveness prober) and
 * the `SessionHandle` built over them, whose request handler admits on that
 * graph. The handle layer opens the root's transcript store over that log and
 * hands it to the handle. Every opener (the hosts' default session, the
 * desktop's papers, the SDK) resolves its root here, so opening a root twice
 * returns one handle, and the map is the one owner of its lifetime: an open
 * borrows, `close` settles and releases, and the runtime's disposal releases
 * whatever is still open.
 */
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Equal,
  Hash,
  Layer,
  LayerMap,
  ManagedRuntime,
  Option,
  Schedule,
  RcMap,
  Stream,
  SubscriptionRef,
  Fiber,
  Scope,
  type FileSystem,
  type Path,
} from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http';

import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import { finalizeRun } from '@agent/storage/runLifecycle';
import { AgentEngine } from '@agent/runtime/AgentEngine';
import {
  executeAgent,
  resumeToolUseFromResumeData,
} from '@agent/runtime/executeAgent';
import { EditorModel } from '@agent/runtime/run/modelBinding';
import { createSessionApprovals } from '@agent/runtime/runApprovalQueue';
import { RunRegistry } from '@agent/runtime/runRegistry';
import { runLedgerLayer } from '@agent/runtime/RunLedger';
import { sessionEventsLayer, tailFrom } from '@agent/runtime/SessionEvents';
import { ModelRetryGate } from '@agent/runtime/ModelRetryGate';
import {
  SessionHandle,
  type SessionHandleInit,
} from '@agent/runtime/SessionHandle';
import {
  initSessionOwner,
  SESSION_CLOSE_DEADLINE_MS,
  type SessionGraph,
} from '@agent/runtime/sessionGraph';
import { SupabaseAuth, type SupabaseAuthShape } from '@auth/SupabaseAuth';
import { withLogChannel } from '@logger/effectLog';
import {
  effectDiagnosticsLayer,
  type MinimumLogLevel,
} from '@logger/effectDiagnostics';
import {
  withForkFailureReporting,
  type ProcessRuntime,
} from '@platform/processRuntime';
import {
  AgentDirectories,
  AgentResume,
  AppState,
  ToolMissingReporter,
  type AgentResumePort,
  type ToolMissingHandler,
} from '@platform/interfaces';
import { LanguageModel, type LanguageModelPort } from '@platform/languageModel';
import { globalStorageFsLayer } from '@platform/rootedFs';
import { Secrets, type PlatformSecrets } from '@platform/secrets';
import {
  processOwnerId,
  type ProcessProbe,
} from '@platform/defaults/nodeProcesses';
import { nodePlatformServices } from '@platform/defaults/nodePlatform';
import { RunLedger } from '@shared/session/runLedger';
import {
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  isDisplaySessionEvent,
  interruptedWorkflowCall,
  ownerIdentity,
  RUN_OUTCOME,
  TOOL_CALL_STATUS,
  type AggregateId,
  type CommitOrdinal,
  type OwnerId,
  type RunId,
  type RunOutcome,
  type SessionCloseReport,
  type SessionEvent,
} from '@shared/schemas';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import { closesRunWindow } from '@shared/session/runRows';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import type { SessionView } from '@shared/session/sessionView';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { SessionInputs } from '@shared/session/sessionInputs';

import {
  Database,
  ProjectDatabases,
  type DatabaseOpenFailed,
  type DatabaseReadFailed,
  type GlobalDatabase,
  type SessionOpenError,
} from '@shared/session/database';
import type { UsageLog } from '@shared/usageLog';
import { releaseRunResources } from '@tools/approval';
import { InlineComments } from '@tools/comment/InlineCommentTool';
import type { InlineCommentProvider } from '@tools/comment/InlineCommentTool';
import { gitHubSubscriptionsLayer } from '@tools/github/subscriptionRegistries';
import { directLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';
import type { LeanLanguageServices } from '@tools/lean/leanLanguageServices';
import { SetupPlatform, type SetupPlatformShape } from '@tools/setup/platform';
import { toolRegistryLayer } from '@tools/registry';
import { processEnvConfigLayer } from '@utils/system/envFlags';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { inquiryRecordsLayer } from './inquiryRecords';
import { updateCheckRecordsLayer } from './updateCheckRecords';
import { databaseLayer } from './Database';
import { projectDatabaseLayer } from './projectDatabase';
import { collectPendingDeletions } from './deletionCleanup';
import { sessionRequests } from './SessionRequests';
import { sweepLeftoverRuns } from './sweepLeftoverRuns';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
  type InflightTextChunk,
} from './sessionSources';
import { SessionViewService } from './SessionView';
import { sessionInputsLayer } from './sessionInputs';
import { WorkspaceRoots } from './WorkspaceRoots';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

const CHANNEL = 'sessionLayer';

/** Log a failure on this channel, with the failure attached as its `data`. */
const logFailure =
  (message: string, log = Effect.logWarning) =>
  (data: unknown) =>
    log(message).pipe(Effect.annotateLogs({ data }), withLogChannel(CHANNEL));

/** How often the owners the view names are re-probed (PRD 5.2). */
const OWNER_LIVENESS_PROBE_INTERVAL = '5 seconds';

/**
 * Which session an entry is: its storage root, the value `SessionView.key`
 * carries, together with what the opener supplied for building it (the roots,
 * the transcript store mode the graph opens its stores with, the response text
 * policy, the host interactions it is born with). Equal and hashed by the
 * storage root alone: two opens of one root resolve one session, over what the
 * first of them supplied. Nothing store-bound can be injected past that
 * boundary (PR #11893, agent SDK architecture proposal, section 3).
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
 * The sessions the owner holds, outside the map: what the owner's synchronous
 * `current` and `held` read, and so the process's one list of live sessions
 * (`heldSessions`) — no module keeps a second one. An
 * entry is written once its handle exists and removed as the first step of its
 * release, so a root whose session is still building, or already unwinding,
 * reads as having none. Keyed by the entry's `SessionKey` and matched on its
 * captured `key.storage` at lookup, as `heldSession` matches. `heldSession`
 * below is the map's own answer, which waits for a building entry;
 * `closeSession` needs that, a synchronous read cannot have it.
 */
type HeldSessions = Map<SessionKey, SessionHandle>;

/** The owner ids of the non-terminal runs another process wrote. */
function foreignOwners(view: SessionView, self: OwnerId): OwnerId[] {
  const foreign = [...view.runs.values()].flatMap((run) =>
    run.ownerId !== null &&
    run.ownerId !== self &&
    !isTerminalOutcomePhase(run.status)
      ? [run.ownerId]
      : [],
  );
  return [...new Set(foreign)].sort();
}

/**
 * The liveness prober (PRD 5.2, contract C5): every owner the view names on a
 * non-terminal run other than this process, proved by `kill(pid, 0)` plus the
 * start-identity check per distinct owner, never per run. Probed whenever that
 * owner set changes and on an interval between changes. Alive and unprovable
 * owners hold their runs; only an explicit death verdict permits an
 * interrupted classification. It writes `dead`; `unreadable` is the status
 * machine's.
 */
const ownerLiveness = Layer.effectDiscard(
  Effect.gen(function* () {
    const view = yield* SessionViewService;
    const local = yield* LocalRuntimeSource;
    const identity = yield* ProcessIdentity;
    const probe = Effect.gen(function* () {
      const owners = foreignOwners(
        yield* SubscriptionRef.get(view.ref),
        identity.ownerId,
      );
      const dead: OwnerId[] = [];
      for (const owner of owners) {
        const liveness = yield* proveOwnerLiveness(ownerIdentity(owner));
        if (liveness === 'dead') dead.push(owner);
      }
      const snapshot = yield* SubscriptionRef.get(local.ref);
      if (
        snapshot.dead.length === dead.length &&
        snapshot.dead.every((owner, i) => owner === dead[i])
      ) {
        return;
      }
      yield* SubscriptionRef.set(local.ref, { ...snapshot, dead });
    });
    const ownerSetChanges = SubscriptionRef.changes(view.ref).pipe(
      Stream.map((current) =>
        foreignOwners(current, identity.ownerId).join(' '),
      ),
      Stream.changes,
    );
    yield* Effect.forkScoped(
      Stream.merge(
        ownerSetChanges,
        Stream.tick(OWNER_LIVENESS_PROBE_INTERVAL),
      ).pipe(
        Stream.mapEffect(() => probe),
        Stream.runDrain,
      ),
    );
  }),
);

/**
 * The handle of one root, over the root's graph: the session is the entry's
 * one service, and its `Runs` and requests are reached through it. The last
 * layer of the entry, so it is the first thing unwound when the entry closes
 * and the graph outlives every publisher above it. The entry's scope is the
 * session's one lifetime: {@link closeSession} and the runtime's disposal
 * both end it by closing that scope, and every owner the handle holds is torn
 * down by a finalizer registered here.
 */
const sessionHandleLayer = (key: SessionKey, held: HeldSessions) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const { publish, exclusive, detach, settle, ...reads } =
        yield* SessionEvents;
      const eventLog = yield* Database;
      const identity = yield* ProcessIdentity;
      const ledger = yield* RunLedger;
      const inquiryRecords = yield* InquiryRecords;
      const agentResume = yield* AgentResume;
      const view = yield* SessionViewService;
      const local = yield* LocalRuntimeSource;
      const inputs = yield* SessionInputs;
      const chunks = yield* TextChunkSource;
      const subscriptions = yield* TranscriptSubscriptions;
      const delivered = yield* SubscriptionRef.make(0);
      const tailEnded = yield* Deferred.make<void, DatabaseReadFailed>();
      const settledCursor = () =>
        Math.min(
          SubscriptionRef.getUnsafe(view.ref).cursor,
          SubscriptionRef.getUnsafe(delivered),
        );
      /** The settled level as a stream: `settledCursor` re-read on every move
       *  of either coordinate. It ends with the fold (`view.changes`, not the
       *  bare ref `folded` wakes on, whose tail outlives every reader), so a
       *  wait on it is answered or dies, never hangs. */
      const settledChanges = Stream.merge(
        view.changes,
        SubscriptionRef.changes(delivered),
        { haltStrategy: 'left' },
      ).pipe(Stream.map(settledCursor));
      /** Wait until the tail has delivered and the view has folded every
       *  commit up to `commit`: what "published" means to a caller that reads
       *  the view next. One wait on the level both coordinates feed, since
       *  `settledCursor` is already their min. */
      const settleTo = (commit: CommitOrdinal) =>
        settledChanges.pipe(
          Stream.filter((cursor) => cursor >= commit),
          Stream.runHead,
          Effect.raceFirst(
            Deferred.await(tailEnded).pipe(
              // The tail outlives every publication it settles; if it ends,
              // pending waits die with its read failure.
              Effect.orDie,
              Effect.andThen(
                Effect.die(
                  new Error('Session committed-event consumer stopped'),
                ),
              ),
            ),
          ),
          Effect.flatMap((cursor) =>
            Option.isSome(cursor)
              ? Effect.void
              : Effect.die(
                  new Error('Session view stopped before publication settled'),
                ),
          ),
        );
      const settlePublication = (rows: readonly SessionEvent[]) => {
        const last = rows.at(-1);
        return last === undefined
          ? Effect.succeed(rows)
          : settleTo(last.commit).pipe(Effect.as(rows));
      };
      const now = () => SubscriptionRef.getUnsafe(eventLog.observedCommit);
      /**
       * This process's holds on aggregate claims, counted: the first holder
       * of an aggregate proves any prior owner dead and takes its claim (or
       * finds it already this process's, as a run's birth claim is), every
       * later holder shares it, and the claim is released when the last
       * holder's scope closes. So nested holders nest — a run holding its
       * own claim for its lifetime, a parent's detach batch over that run,
       * a deletion's hold — and none of them releases under another. The map
       * closes with the session, releasing whatever is still held.
       */
      const claims = yield* RcMap.make({
        lookup: (id: AggregateId) =>
          Effect.acquireRelease(
            eventLog.acquireClaims([id]).pipe(
              // A claim moving here seeds the publisher's pending follow-ups.
              Effect.tap((ids) => reads.hydrateFollowUps(id, ids.length > 0)),
            ),
            () =>
              eventLog
                .releaseClaims([id])
                .pipe(
                  Effect.catch(
                    logFailure(
                      `The claim on ${id} was not released; the next process proves this one dead before it takes the claim.`,
                    ),
                  ),
                ),
          ),
      });
      const graph = (session: SessionHandle): SessionGraph => {
        // The session scope owns one approval state shared by its runs and
        // request handler. Effective changes publish the full policy snapshot.
        const approvals = createSessionApprovals((runId) =>
          session.publishApprovalPolicy(runId),
        );
        return {
          events: reads,
          ledger,
          publishText: (runId, id, text) =>
            SubscriptionRef.update(chunks.ref, (held) => {
              const next = new Map(held);
              const key = `${runId}/${id}`;
              const previous = next.get(key);
              next.set(key, {
                previous,
                text,
                length: (previous?.length ?? 0) + text.length,
              });
              return next;
            }),
          readText: (runId, id) => {
            let chunk = SubscriptionRef.getUnsafe(chunks.ref).get(
              `${runId}/${id}`,
            );
            if (chunk === undefined) return undefined;
            const pieces: string[] = [];
            while (chunk !== undefined) {
              pieces.push(chunk.text);
              chunk = chunk.previous;
            }
            return pieces.reverse().join('');
          },
          acquireClaims: (id) =>
            Effect.gen(function* () {
              const hold = yield* Scope.make();
              yield* RcMap.get(claims, id).pipe(
                Scope.provide(hold),
                Effect.onError(() => Scope.close(hold, Exit.void)),
              );
              return Scope.close(hold, Exit.void);
            }),
          runRecords: (id) =>
            eventLog.readRunRecords(qualifyAggregateId('run', id)),
          ownsRun: (id) =>
            eventLog
              .aggregateState([qualifyAggregateId('run', id)])
              .pipe(
                Effect.map((states) =>
                  states.some(
                    (state) =>
                      state.startCommit !== null &&
                      !state.closed &&
                      state.ownerId === identity.ownerId,
                  ),
                ),
              ),
          claimOwner: (id) =>
            eventLog.claimOwner(qualifyAggregateId('run', id)),
          recordListing: () => eventLog.readListing(),
          aggregateRows: (id) => eventLog.readAggregate(id, 1),
          publish: (events) =>
            publish(events).pipe(Effect.flatMap(settlePublication)),
          // A job settles against the last commit it appended, never against
          // whatever the publisher committed next: a job that appended nothing
          // (a decision already taken, an empty update) returns at once.
          exclusive: (job) =>
            Effect.gen(function* () {
              let committed: CommitOrdinal | null = null;
              const value = yield* exclusive((append) =>
                job((events) =>
                  append(events).pipe(
                    Effect.tap((rows) =>
                      Effect.sync(() => {
                        const last = rows.at(-1);
                        if (last !== undefined) committed = last.commit;
                      }),
                    ),
                  ),
                ),
              );
              if (committed !== null) yield* settleTo(committed);
              return value;
            }),
          detach,
          settle: settle.pipe(
            Effect.flatMap((committed) =>
              committed === null ? Effect.void : settleTo(committed),
            ),
          ),
          publishRegistration: (events) =>
            Effect.gen(function* () {
              const rows = yield* publish(events);
              const born = rows.flatMap((row) =>
                row.type === 'run.start' ? [row.aggregateId] : [],
              );
              return yield* settlePublication(rows).pipe(
                Effect.onError(() =>
                  eventLog.releaseClaims(born).pipe(
                    // The settle's failure is what the caller hears; a release
                    // that also failed leaves the claims to the next process's
                    // liveness proof, and says so.
                    Effect.catch(
                      logFailure(
                        'Registration claims were not released after its settle failed.',
                      ),
                    ),
                  ),
                ),
              );
            }),
          view: view.ref,
          viewChanges: view.changes,
          storeCleared: eventLog.cleared,
          // Release rows only once both the view fold and local reconciliation
          // have applied them. Readers can then query either state consistently.
          folded: (fromCommit) =>
            tailFrom(
              (from) =>
                Stream.fromIterableEffect(eventLog.readAll(from)).pipe(
                  Stream.filter(isDisplaySessionEvent),
                ),
              {
                get: Effect.sync(settledCursor),
                changes: Stream.merge(
                  SubscriptionRef.changes(view.ref),
                  SubscriptionRef.changes(delivered),
                ).pipe(Stream.map(settledCursor)),
              },
              fromCommit,
            ),
          local: local.ref,
          inputs: inputs.read,
          subscriptions,
          // The session's runs, over the session's own doors: each is called
          // only once the handle it names is built.
          runs: new RunRegistry({
            runView: (runId) => session.runView(runId),
            commit: (events) => session.commit(events).pipe(Effect.asVoid),
            approvals,
            finalizeRun: (input) => finalizeRun(session, input),
            holdRunClaim: (runId) => session.holdRunClaim(runId),
          }),
          // The session's requests: the approval state above and the handler
          // that admits on the root graph's log.
          requests: sessionRequests(
            session,
            approvals,
            eventLog,
            local.ref,
            inquiryRecords,
            agentResume,
          ),
          now,
        };
      };
      // Capture before constructing the handle: constructor publications and
      // commits preceding subscription are covered by the tail's first read.
      const anchor = yield* eventLog.currentCommit;
      // Register the consumer's scope first so handle teardown can publish and
      // drain while both this tail and the underlying view are still alive.
      const consumerScope = yield* Effect.acquireRelease(
        Scope.make(),
        (scope, exit) => Scope.close(scope, exit),
      );
      // Capture the startup cohort before callers can publish new launches.
      const initialListing = yield* eventLog.readListing();
      // The gate's probe fibers and waiting calls end with this scope, after
      // the handle below has unwound its runs.
      const modelRetries = yield* ModelRetryGate.make;
      const session = new SessionHandle({ ...key.open, graph, modelRetries });
      // The session's teardown is this scope's finalizers, run in the reverse
      // of their registration: the handle's own doors shut last, after every
      // owner below has unwound, with the publications they left settled
      // (logged, so the entry's release still finishes); then the follow-up
      // queue, the approval state (bypasses dropped before the interaction
      // slot settles pending approvals), the presentation hosts; and first of
      // all the runs, so no run is admitted over a session that is unwinding.
      yield* Effect.addFinalizer(() =>
        session
          .settlePublications()
          .pipe(
            Effect.catch(
              logFailure(
                `Session ${key.storage} left a failed publication behind as it closed.`,
              ),
            ),
            Effect.ensuring(Effect.sync(() => session.closeDoors())),
          ),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => session.followUps.dispose()),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => session.approvals.clearAll()),
      );
      yield* Effect.addFinalizer(() => session.interactions.dispose());
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => session.runs.dispose()),
      );
      // The presentation host an opener hands over is attached here, as its
      // own step: `use` replays what is queued for it, which is a program,
      // and a constructor cannot run one.
      if (key.open.interactions) {
        yield* session.interactions.use(key.open.interactions);
      }
      // Registered after the owners, so it is the first thing unwound when
      // the entry closes: `current` stops answering with this session before
      // its owners unwind.
      yield* Effect.acquireRelease(
        Effect.sync(() => held.set(key, session)),
        () => Effect.sync(() => held.delete(key)),
      );
      yield* SubscriptionRef.set(delivered, anchor);
      yield* reads.all(anchor, delivered).pipe(
        Stream.runForEach((event) =>
          Effect.suspend(() => {
            const target = aggregateTarget(event.aggregateId);
            // The local half of a committed removal. The run's goal needs
            // nothing: `run.removed` drops the run from the view, and its
            // `goalStateChanged` row goes with it.
            return event.type === 'run.removed' && target.kind === 'run'
              ? Effect.sync(() => {
                  session.runs.detachChildren(target.id);
                  releaseRunResources(target.id, session);
                })
              : Effect.void;
          }).pipe(
            Effect.andThen(() => {
              // A row that closes live text drops the held chunks: a
              // stream's final text or a card's terminal result drop their
              // own; a phase move that rests or ends the run, and its
              // removal, drop every chunk of the run, so a card an
              // interrupted run closed without a terminal row holds nothing.
              const runId = aggregateTarget(event.aggregateId).id;
              let drop: ((key: string) => boolean) | null = null;
              if (event.type === 'stream.end') {
                drop = (key) => key === `${runId}/${event.id}`;
              } else if (
                event.type === 'tool.end' &&
                event.status !== TOOL_CALL_STATUS.IN_PROGRESS
              ) {
                drop = (key) => key === `${runId}/${event.logId}`;
              } else if (
                event.type === 'run.removed' ||
                closesRunWindow(event)
              ) {
                drop = (key) => key.startsWith(`${runId}/`);
              }
              const dropping = drop;
              return dropping === null
                ? Effect.void
                : SubscriptionRef.update(chunks.ref, (held) => {
                    let next: Map<string, InflightTextChunk> | null = null;
                    for (const key of held.keys()) {
                      if (!dropping(key)) continue;
                      next ??= new Map(held);
                      next.delete(key);
                    }
                    return next ?? held;
                  });
            }),
            Effect.andThen(SubscriptionRef.set(delivered, event.commit)),
          ),
        ),
        Effect.tapError(
          logFailure(
            `Session ${key.storage} stopped delivering committed rows: the log could not be read.`,
            Effect.logError,
          ),
        ),
        Effect.onExit((exit) => Deferred.done(tailEnded, exit)),
        Effect.forkIn(consumerScope),
      );
      // The registry's phase notification rides the fold-gated tail, not the
      // raw one above: its waiters and child rosters read `RunView.status`
      // synchronously, so a row reaches them only once the view holds the
      // state it produced.
      yield* Stream.runForEach(session.folded(anchor), (event) =>
        session.receiveFoldedEvent(event),
      ).pipe(
        Effect.catch(
          logFailure(
            `Session ${key.storage} stopped delivering folded rows: the log could not be read.`,
            Effect.logError,
          ),
        ),
        Effect.forkIn(consumerScope),
      );
      yield* sweepLeftoverRuns(session, initialListing).pipe(
        Effect.catch(logFailure('Background-shell cleanup failed.')),
        Effect.forkScoped,
      );
      // The session owns retries and waits for in-flight removal on close.
      yield* collectPendingDeletions(eventLog, key.storage).pipe(
        Effect.catch(
          logFailure(
            'Deletion records could not be read; cleanup remains pending.',
          ),
        ),
        Effect.repeat({ schedule: Schedule.spaced('30 seconds') }),
        Effect.forkScoped,
      );
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
    Layer.provideMerge(runLedgerLayer),
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
 * The complete session of one root: the handle over the root's graph, the
 * handle alone being the entry's service. `Layer.fresh`: the layer map builds
 * every key's entry through one memo map, and layers memoize by reference, so
 * without it every root would share one log and one fold. The graph's sources
 * and ephemeral database are fresh; a persistent graph retains its database
 * from `ProjectDatabases`, shared with the project's application state. That
 * resource family and the process identity come from the runtime's context.
 */
const sessionLayer = (key: SessionKey, held: HeldSessions) =>
  Layer.fresh(
    sessionHandleLayer(key, held).pipe(Layer.provide(sessionGraphLayer(key))),
  );

/**
 * The keyed resource family the desktop's N papers and the SDK's N roots need:
 * one session per root, held by the map until `close` releases it or the
 * runtime goes. Opens borrow (the reference an open takes is released at once)
 * and the idle lifetime is infinite, so no reader's detachment and no
 * reference count decides a session's end: the application does, explicitly
 * (PR #11893, agent SDK architecture proposal, section 3).
 */
class Sessions extends Context.Service<
  Sessions,
  LayerMap.LayerMap<SessionKey, Session, SessionOpenError>
>()('@texra/session/Sessions') {
  static layer(held: HeldSessions) {
    return Layer.effect(
      Sessions,
      LayerMap.make((key: SessionKey) => sessionLayer(key, held), {
        idleTimeToLive: Duration.infinity,
      }),
    );
  }
}

/** The session of `open`'s root: built now, or the one already open. A
 *  build that fails leaves no entry behind (the map would otherwise answer
 *  every later open of the root with the cached failure). */
const openSession = (open: SessionHandleInit) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const key = new SessionKey(open);
    const context = yield* sessions
      .contextEffect(key)
      .pipe(Effect.onError(() => sessions.invalidate(key)));
    return Context.get(context, Session);
  }).pipe(Effect.scoped);

/** Every session the map holds, entries still building waited for. Builds
 *  nothing: a key whose entry has been released is skipped. */
const listSessions = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const keys = yield* RcMap.keys(sessions.rcMap);
  const held: SessionHandle[] = [];
  for (const key of keys) {
    const entry = yield* sessions
      .contextEffectOption(key)
      .pipe(Effect.scoped, Effect.catch(unopenedEntry(key)));
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
 *  an open find the session (`SessionOwner.open`). Builds nothing. The owner's
 *  `current` reads the `HeldSessions` map instead: it answers synchronously
 *  and so cannot wait for a build. */
const heldSession = (root: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
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
 * live when its budget ran out. Under the run's claim, the transcript groups
 * it left open are closed and its outcome is recorded — CANCELLED unless its
 * driver already wrote one — with its checkpoint kept, since a cancelled run
 * is exactly the one a user resumes; then the claim is released. A driver
 * that writes a different outcome after this is a separate lifecycle race:
 * `keepExistingOutcome` only protects earlier writes. A failure is logged,
 * never raised: a later launch classifies the run from its checkpoint.
 */
const settleRun = (session: SessionHandle, runId: RunId): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!(yield* session.ownsRun(runId))) return;
    const tracked = session.runs.getHandle(runId) !== undefined;
    // Read what the publisher holds open once queued publications settle, so
    // every row they commit is counted.
    const open = yield* Effect.exit(
      session
        .settlePublications()
        .pipe(Effect.map(() => (tracked ? session.openWork(runId) : []))),
    );
    // The run's closure facts, queued and settled under the same lease
    // *before* the terminal row: that row is the one place their loss is
    // reported (the `artifact-drain` marker).
    const closeTranscriptGroups = (
      outcome: RunOutcome,
    ): Effect.Effect<Error | undefined> =>
      Effect.gen(function* () {
        if (!tracked) {
          yield* Effect.logWarning(
            `Run ${runId} was untracked while its session closed; any transcript groups it left open stay open`,
          ).pipe(withLogChannel(CHANNEL));
          return undefined;
        }
        if (Exit.isFailure(open)) return undefined;
        for (const work of open.value) {
          if (work.kind === 'stage') {
            session.publishRunEvent(runId, {
              type: 'stage.end',
              id: work.id,
              status: outcome,
            });
          } else if (work.kind === 'stream') {
            session.publishRunEvent(runId, { type: 'stream.end', id: work.id });
          } else {
            session.publishRunEvent(runId, {
              type: 'workflow.call',
              logId: work.id,
              stageId: work.stageId,
              call: interruptedWorkflowCall(work.call),
            });
          }
        }
        const settled = yield* Effect.exit(session.settlePublications(runId));
        return Exit.isFailure(settled)
          ? ensureError(Cause.squash(settled.cause))
          : undefined;
      });
    yield* session.commitRunEnd(runId, (drainFailure) =>
      Effect.gen(function* () {
        const closureFailure = yield* closeTranscriptGroups(
          session.runView(runId)?.durableOutcome ?? RUN_OUTCOME.CANCELLED,
        );
        const lostFacts = drainFailure ?? closureFailure;
        const finalization = yield* finalizeRun(session, {
          runId,
          outcome: RUN_OUTCOME.CANCELLED,
          keepExistingOutcome: true,
          ...(lostFacts === undefined
            ? {}
            : {
                error: {
                  kind: 'artifact-drain' as const,
                  message: toErrorMessage(lostFacts),
                },
              }),
        });
        if (!finalization.ok) {
          throw new Error(
            `Failed to persist the CANCELLED outcome for run ${runId}`,
            { cause: finalization.error },
          );
        }
        if (Exit.isFailure(open)) throw Cause.squash(open.cause);
        if (closureFailure !== undefined) throw closureFailure;
      }),
    );
  }).pipe(
    Effect.scoped,
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
 * Close the session of one root: the one way a session ends, whoever asks —
 * an SDK close, a desktop project's close, a host's shutdown, a host
 * releasing its default session. In order, on the caller's fiber:
 *
 * 1. refuse new runs and kill the background OS processes its runs own;
 * 2. stop every run (the stop cascades into children) and wait for their
 *    drivers to settle them, inside one budget: the shutdown-phase deadline;
 * 3. settle from here each run still live when the budget runs out
 *    ({@link settleRun}), reporting it as abandoned;
 * 4. release the entry, whose finalizers flush the session's publications
 *    and unwind its owners.
 *
 * The whole close is uninterruptible, so the budget is its one cancellation
 * channel: the stop and its wait run interruptible inside it, so the deadline
 * cuts them, and every step after the deadline still runs.
 */
const closeSession = (root: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const held = yield* heldSession(root);
    // A root with nothing open: nothing to settle, nothing abandoned.
    if (held === undefined)
      return { settled: true, abandoned: [] } satisfies SessionCloseReport;
    const { key, session, runs } = held;
    runs.closeAdmissions();
    runs.killBackgroundProcesses();
    // A run the stop reached no driver for, or whose stop failed, has nothing
    // to settle it: the close settles it now instead of waiting out the
    // budget for it.
    const undriven = yield* runs.stopAll();
    for (const runId of undriven) {
      yield* settleRun(session, runId);
      const handle = runs.getHandle(runId);
      if (handle) runs.untrackIfCurrent(handle);
    }
    const drained = yield* runs
      .awaitDrained()
      .pipe(
        Effect.interruptible,
        Effect.timeoutOption(SESSION_CLOSE_DEADLINE_MS),
      );
    const settled = Option.isSome(drained);
    const abandoned = settled ? [] : runs.activeIds();
    if (abandoned.length > 0) {
      yield* Effect.logWarning(
        `Session ${root} closed with runs still live past its budget; settling them from the close: ${abandoned.join(', ')}`,
      ).pipe(withLogChannel(CHANNEL));
      yield* Effect.forEach(abandoned, (runId) => settleRun(session, runId), {
        discard: true,
      });
    }
    yield* sessions.invalidate(key);
    return { settled, abandoned } satisfies SessionCloseReport;
  }).pipe(Effect.uninterruptible);

/**
 * Make the one Effect runtime of this process over its identity (PRD 7.7) and
 * install it with the session family it serves: called by a composition root
 * exactly once at startup, which calls
 * {@link disposeProcessRuntime} on its shutdown path after the last session
 * has released its graph. Every root passes the process-start read as a
 * program over this runtime's spawner, read once per process as one of the
 * process services below. The owner it installs answers in Effect, on the
 * opener's own fiber; its one synchronous face, `current`, reads the held
 * map and runs nothing.
 *
 * Host values and resource-owning layers are composed here once. Secrets and
 * identity resolve at bootstrap; AppState is acquired in the process scope,
 * and the agent-directory layer captures it before serving any reads. Hosts
 * with externally owned stores supply them through AppState.layer. A CLI
 * entry without application state supplies a refusing store and database.
 */
interface ProcessRuntimeOptions {
  readonly processStart: Effect.Effect<string | undefined, never, ProcessProbe>;
  readonly globalStorage: string;
  readonly secrets: PlatformSecrets;
  /**
   * The root's agent-resume port, served as `AgentResume`: the same value the
   * root wires into its platform, required of every entry even where it always
   * answers `false` (the agent package's embedder default).
   */
  readonly agentResume: AgentResumePort;
  /**
   * The host's agent-directory layer, which can capture AppState at construction
   * without exposing that dependency in its readers.
   */
  readonly agentDirectories: Layer.Layer<AgentDirectories, never, AppState>;
  /**
   * The host's tool-missing reporter, served as `ToolMissingReporter`. Optional
   * because only the VS Code host has a UI for it; an absent reporter serves
   * the no-op, so a missing-tool probe still answers without surfacing.
   */
  readonly toolMissingReporter?: ToolMissingHandler;
  /**
   * The host's global application-state layer, acquired in this runtime's scope.
   * A platform-less CLI entry supplies its refusing store through AppState.layer
   * so it creates no storage on a possibly read-only root.
   */
  readonly appState: Layer.Layer<
    AppState,
    DatabaseOpenFailed,
    GlobalDatabase | ProcessIdentity | ProcessProbe
  >;
  /**
   * The root's account plane, served as `SupabaseAuth`. Every shipped host
   * builds one from its secrets; a composition with no TeXRA account plane (the
   * agent package serving an embedder) serves `unavailableSupabaseAuth()`,
   * whose probes answer signed-out.
   */
  readonly auth: SupabaseAuthShape;
  /**
   * The host's editor language-model bridge, served as `LanguageModel`. Every
   * host has a value for it: the VS Code extension's bridge to the editor's
   * language-model API, or `UNAVAILABLE_LANGUAGE_MODEL_PORT` elsewhere, where
   * discovery discovers nothing.
   */
  readonly languageModel: LanguageModelPort;
  readonly setup: SetupPlatformShape;
  /**
   * The editor's language models, for the one host that has an editor: the
   * run layer binds `vscode-lm` models through it. Absent on a host without
   * one, where binding such a model fails with that fact.
   */
  readonly editorModel?: EditorModel['Service'];
  /**
   * The host's inline-comment provider, for the one host with a Comments UI.
   * Absent elsewhere, where the tool is off the roster and a call that
   * reached it anyway fails naming the missing host wiring.
   */
  readonly inlineComments?: InlineCommentProvider;
  /**
   * The host's Lean language services, built and closed with the runtime.
   * Absent, the direct `lake env lean --server` pool over this install's
   * `FileSystem`/`Path`; VS Code passes its Lean 4 extension bridge.
   */
  readonly lean?: Layer.Layer<
    LeanLanguageServices,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner | AppState
  >;
  /**
   * The host's usage layer owns its version-stamped sender and final drain.
   * `UsageLog.disabled` reports no usage. The host supplies the layer so this
   * composition does not reach into telemetry.
   */
  readonly usageLog: Layer.Layer<
    UsageLog,
    never,
    HttpClient.HttpClient | SupabaseAuth
  >;
  /**
   * The process's handle on the global storage root —
   * `globalDatabaseLayer(globalStorage)` on every entry that has one — built
   * with this runtime and closed when it is disposed. It is the entry's to pass
   * for the reason `appState` is: opening the handle creates the global storage
   * directory and its SQLite file and forks that root's change poll for the
   * process's life, and the one entry that runs before any platform, on a
   * possibly read-only root, and that disposes no runtime, must do none of the
   * three. It hands over a refusing layer beside its refusing store.
   */
  readonly globalDatabase: Layer.Layer<
    GlobalDatabase,
    DatabaseOpenFailed,
    ProcessIdentity | ProcessProbe
  >;
  /**
   * The runtime's emission threshold for Effect diagnostics, from facts the
   * composition root holds that cannot change mid-process: the surface kind
   * (the extension's `LogOutputChannel` filters for itself, so it passes
   * `'Trace'`; the desktop's rotated log file passes `'Debug'`) or the CLI's
   * `--quiet` / `--verbose` argv. The reference it feeds is fiberCached and
   * read before any logger runs, which is exactly why a live user setting
   * must arrive by another road (the transcript fold's `debug` flag) and not
   * here.
   */
  readonly minimumLogLevel: MinimumLogLevel;
}

export function installProcessRuntime({
  processStart,
  globalStorage,
  secrets,
  appState,
  auth,
  languageModel,
  agentResume,
  agentDirectories,
  toolMissingReporter,
  setup,
  editorModel,
  inlineComments,
  lean = directLeanLanguageServices(),
  usageLog,
  globalDatabase: globalDatabaseOption,
  minimumLogLevel,
}: ProcessRuntimeOptions): ProcessRuntime {
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
    inquiryRecordsLayer,
    updateCheckRecordsLayer,
    Secrets.layer(secrets),
    SupabaseAuth.layer(auth),
    LanguageModel.layer(languageModel),
    AgentResume.layer(agentResume),
    agentDirectories,
    toolMissingReporter === undefined
      ? Layer.empty
      : ToolMissingReporter.layer(toolMissingReporter),
    SetupPlatform.layer(setup),
    toolRegistryLayer,
    Layer.succeed(AgentEngine)({ executeAgent, resumeToolUseFromResumeData }),
    // Built with this runtime: a replacement starts with empty tables.
    gitHubSubscriptionsLayer,
    editorModel === undefined
      ? Layer.empty
      : Layer.succeed(EditorModel)(editorModel),
    inlineComments === undefined
      ? Layer.empty
      : Layer.succeed(InlineComments)(inlineComments),
  ).pipe(
    Layer.provideMerge(appState.pipe(Layer.orDie)),
    Layer.provideMerge(identity),
  );
  // Give an opener only this runtime's Sessions on its own fiber.
  const onThisRuntime = <A, E>(
    effect: Effect.Effect<A, E, Sessions>,
  ): Effect.Effect<A, E> =>
    Effect.flatMap(runtime.contextEffect, (context) =>
      Effect.provideService(effect, Sessions, Context.get(context, Sessions)),
    );
  const held: HeldSessions = new Map();
  const runtime = withForkFailureReporting(
    ManagedRuntime.make(
      Sessions.layer(held).pipe(
        Layer.provideMerge(projectDatabaseLayer),
        // The usage log's own lifetime: its sender and ticker run as long as
        // this runtime does, and its finalizer drains the queue while the
        // account plane below is still up. Ahead of `services` in the chain so
        // that plane and the HTTP client reach it.
        Layer.provideMerge(usageLog),
        // The editor's Lean port also reads this process's AppState.
        Layer.provideMerge(lean),
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
            // Filesystem, path, spawner and env ConfigProvider, once per
            // process: no consumer builds its own.
            nodePlatformServices,
            processEnvConfigLayer,
          ),
        ),
      ),
    ),
  );
  initSessionOwner({
    runtime,
    open: (open) => onThisRuntime(openSession(open)),
    current: (root) => [...held].find(([key]) => key.storage === root)?.[1],
    held: () => [...held.values()],
    list: () => onThisRuntime(listSessions),
    close: (root) => onThisRuntime(closeSession(root)),
  });
  return runtime;
}

/**
 * Uninstall the session owner and dispose `runtime`, the one this process's
 * root installed it with, releasing every session still open there: the one
 * shutdown step for both, so a close issued after it answers as a process
 * with no owner does instead of reaching the disposed runtime.
 *
 * The caller passes the runtime it holds. The owner is uninstalled first and
 * the runtime stays alive for the whole of its own disposal: its layer
 * finalizers are what release the open sessions, and they still publish while
 * they unwind -- a session entry's finalizers unwind its owners and then
 * await the publications that teardown left in flight
 * (`SessionHandle.settlePublications`), on the releasing fiber.
 *
 * Idempotent and safe to race: a second call joins the disposal already in
 * flight rather than starting another. The extension's shutdown path runs it
 * as a finalizer (`Effect.ensuring`) and permits a later shutdown, so both run.
 */
let disposal: Effect.Effect<void> | undefined;

export function disposeProcessRuntime(
  runtime: ProcessRuntime,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    if (disposal) return disposal;
    initSessionOwner(undefined);
    // What a racing caller joins: the disposal in flight, not a second one.
    const joined = Deferred.makeUnsafe<void>();
    disposal = Deferred.await(joined);
    return runtime.disposeEffect.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          disposal = undefined;
          Deferred.doneUnsafe(joined, exit);
        }),
      ),
    );
  });
}
