/**
 * The per-session Effect graph and the process's keyed family of them (PRD
 * one-fold-three-renderers, 7.3 and 7.7). `Sessions` is a `LayerMap`
 * keyed by workspace storage root: one session per root and one only,
 * built on the one `ManagedRuntime` each process makes at its entry
 * (`installProcessRuntime`). A root's entry is the complete session: the
 * root-scoped services (the database event log, the session event reads and
 * publications, the fold, the session inputs, the three local sources, and
 * the owner-liveness prober) and the `SessionHandle` built over them, whose
 * request handler admits on that graph. The handle layer opens the root's
 * transcript store over that log and hands it to the handle. Every opener
 * (the hosts' default session,
 * the desktop's papers, the SDK) resolves its root here, so opening a root
 * twice returns one handle, and the map is the one owner of its lifetime:
 * an open borrows, `close` settles and releases, and the runtime's disposal
 * releases whatever is still open.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node';
import {
  Context,
  Deferred,
  Duration,
  Effect,
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
import { FetchHttpClient } from 'effect/unstable/http';

import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import { finalizeRun } from '@agent/storage/runLifecycle';
import {
  AGENT_TOOL_INJECTIONS,
  ToolInjections,
} from '@agent/runtime/toolInjection';
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
  type SessionGraph,
} from '@agent/runtime/sessionGraph';
import { SupabaseAuth, type SupabaseAuthShape } from '@auth/SupabaseAuth';
import { createLog } from '@logger/logUtils';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import {
  withForkFailureReporting,
  type ProcessRuntime,
} from '@platform/processRuntime';
import {
  AgentResume,
  AppState,
  type AgentResumePort,
  type StateStore,
} from '@platform/interfaces';
import { LanguageModel, type LanguageModelPort } from '@platform/languageModel';
import { globalStorageFsLayer } from '@platform/rootedFs';
import { Secrets, type PlatformSecrets } from '@platform/secrets';
import { SHUTDOWN_PHASE_DEADLINE_MS } from '@platform/defaults/lifecycleHost';
import { processOwnerId } from '@platform/defaults/nodeProcesses';
import { RunLedger } from '@shared/session/runLedger';
import {
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  isDisplaySessionEvent,
  ownerIdentity,
  TOOL_CALL_STATUS,
  type CommitOrdinal,
  type OwnerId,
  type SessionCloseReport,
  type SessionEvent,
} from '@shared/schemas';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import type { SessionView } from '@shared/session/sessionView';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { SessionInputs } from '@shared/session/sessionInputs';

import {
  Database,
  GlobalDatabase,
  type DatabaseReadFailed,
  type SessionOpenError,
} from '@shared/session/database';
import { releaseRunResources } from '@tools/approval';
import type { LeanLanguageServices } from '@tools/lean/leanLanguageServices';
import { SetupPlatform, type SetupPlatformShape } from '@tools/setup/platform';
import { StreamLogStore } from '@transcript/StreamLogStore';
import { inquiryRecordsLayer } from './inquiryRecords';
import { updateCheckRecordsLayer } from './updateCheckRecords';
import { databaseLayer, globalDatabaseLayer } from './Database';
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

const log = createLog('sessionLayer');

/** How often the owners the view names are re-probed (PRD 5.2). */
const OWNER_LIVENESS_PROBE_INTERVAL = '5 seconds';

/**
 * Which session an entry is: its storage root, the value `SessionView.key`
 * carries, together with what the opener supplied for building it (the
 * roots, the transcript store mode the graph opens its stores with, the
 * response text policy, the host interactions it is born with).
 * Equal and hashed by the storage root alone: two opens of one root resolve
 * one session, over what the first of them supplied. Nothing store-bound
 * can be injected past that boundary (PR #11893, agent SDK architecture
 * proposal, section 3).
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
 * The sessions the owner holds, outside the map: what the owner's
 * synchronous `current` and `held` read, and so the process's one list of
 * live sessions (`heldSessions`, `forEachLiveSession`) — no module keeps a
 * second one. An entry is written once its handle exists
 * and removed as the first step of its release, so a root whose session is
 * still building, or already unwinding, reads as having none. Keyed by the
 * entry's `SessionKey` and matched on its captured `key.storage` at lookup,
 * as `heldSession` matches. A session retains the roots resolved when it opens. `heldSession` below is the map's own answer, which
 * waits for a building entry; `closeSession` needs that, a synchronous read
 * cannot have it.
 */
type HeldSessions = Map<SessionKey, SessionHandle>;

/** The held session whose key names `root`, if one does. */
function heldSessionSync(
  held: HeldSessions,
  root: string,
): SessionHandle | undefined {
  for (const [key, session] of held) {
    if (key.storage === root) return session;
  }
  return undefined;
}

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
 * The liveness prober (PRD 5.2, contract C5): every owner the view names
 * on a non-terminal run other than this process, proved by
 * `kill(pid, 0)` plus the start-identity check per distinct owner, never
 * per run. Probed whenever that owner set changes and on an interval
 * between changes. Alive and unprovable owners hold their runs; only an
 * explicit death verdict permits an interrupted classification. It writes `dead`;
 * `unreadable` is the status machine's.
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
 * The one teardown of a session's owners, in order: its runs first, so no run
 * is admitted over a session that is unwinding (a lane step still waiting is
 * refused and every waiter wakes), then the handle's own owners. Every step is
 * synchronous and they run on one fiber with no await between them, so nothing
 * interleaves. Idempotent: the entry's release runs it, and so does the
 * handle's `dispose` before it asks for that release (`graph.close`).
 */
function unwindSession(session: SessionHandle): Effect.Effect<void> {
  return Effect.suspend(() => {
    session.runs.dispose();
    return session.unwind();
  });
}

/**
 * The handle of one root, over the root's graph: the session is the entry's
 * one service, and its `Runs` and requests are reached through it.
 * The last layer of the entry, so it is the first thing unwound when the
 * entry closes and the graph outlives every publisher above it. Every
 * release goes through the entry: `close` and the runtime's disposal
 * invalidate it, and the handle's own `dispose` asks for the same through
 * `graph.close`.
 */
const sessionHandleLayer = (
  key: SessionKey,
  held: HeldSessions,
  release: (key: SessionKey) => Effect.Effect<void>,
) =>
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
      /** The settled level as a stream: `settledCursor` re-read on every
       *  move of either coordinate. It ends with the fold (`view.changes`,
       *  rather than the bare ref `folded` wakes on, whose tail outlives
       *  every reader), so a wait on it is answered or dies, never hangs. */
      const settledChanges = Stream.merge(
        view.changes,
        SubscriptionRef.changes(delivered),
        { haltStrategy: 'left' },
      ).pipe(Stream.map(settledCursor));
      /** Wait until the tail has delivered and the view has folded every
       *  commit up to `commit`: what "published" means to a caller that
       *  reads the view next. One wait on the level both coordinates feed,
       *  since `settledCursor` is already their min. */
      const settleTo = (commit: CommitOrdinal) =>
        settledChanges.pipe(
          Stream.filter((cursor) => cursor >= commit),
          Stream.runHead,
          Effect.raceFirst(
            Deferred.await(tailEnded).pipe(
              // Invariant: the tail outlives every publication it settles.
              // A wait on a tail that ended can never be answered, so it
              // dies, with the read failure that ended the tail, if any.
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
      const graph = (session: SessionHandle): SessionGraph => {
        // The session's approval state, built here rather than by the handle
        // so that its runs and its request handler share the one instance and
        // the session's scope owns it. The authority publishes a stream's
        // full policy snapshot on every effective bypass change;
        // `SessionHandle.setApprovalPolicy` publishes the same snapshot when
        // the policy half moves.
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
            eventLog
              .acquireClaims([id])
              .pipe(Effect.map((ids) => eventLog.releaseClaims(ids))),
          releaseClaims: (id) => eventLog.releaseClaims([id]),
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
          runChildren: (id) =>
            eventLog.readRunChildren(qualifyAggregateId('run', id)),
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
                    Effect.catch((error) =>
                      Effect.sync(() =>
                        log.warn(
                          'Registration claims were not released after its settle failed.',
                          { data: error },
                        ),
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
            acquireRunClaim: (runId) =>
              session.acquireClaims(qualifyAggregateId('run', runId)),
            releaseRootRunLease: (runId) => session.releaseRunLease(runId),
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
          // The teardown runs at once, before the release: an entry another
          // open or close is still borrowing is released only when that borrow
          // ends, and the session refuses new runs from the moment it is asked
          // to close. A teardown failure still releases the entry.
          close: () =>
            unwindSession(session).pipe(Effect.ensuring(release(key))),
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
      const transcripts = yield* StreamLogStore.open(
        eventLog,
        initialListing,
        key.open.transcriptMode,
      );
      // The gate's probe fibers and waiting calls end with this scope, after
      // the handle below has unwound its runs.
      const modelRetries = yield* ModelRetryGate.make;
      const session = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const handle = new SessionHandle({
            ...key.open,
            transcripts,
            graph,
            modelRetries,
          });
          // The presentation host an opener hands over is attached here, as
          // its own step: `use` replays what is queued for it, which is a
          // program, and a constructor cannot run one.
          if (key.open.interactions) {
            yield* handle.interactions.use(key.open.interactions);
          }
          return handle;
        }),
        (session) =>
          unwindSession(session).pipe(
            // Settlement reports what the session's own publications left
            // behind. The release still has to finish, so that report is
            // logged here rather than escaping `Scope.close` and failing the
            // `invalidate` or `close` that asked for the release.
            Effect.ensuring(
              session.settlePublications().pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    log.warn(
                      `Session ${key.storage} left a failed publication behind as it closed.`,
                      { data: error },
                    );
                  }),
                ),
              ),
            ),
          ),
      );
      // Registered after the handle, so it is the first thing unwound when
      // the entry closes: `current` stops answering with this session before
      // its owners unwind.
      yield* Effect.acquireRelease(
        Effect.sync(() => held.set(key, session)),
        () => Effect.sync(() => held.delete(key)),
      );
      yield* SubscriptionRef.set(delivered, anchor);
      yield* reads.all(anchor, delivered).pipe(
        Stream.runForEach((event) =>
          session.receiveCommittedEvent(event).pipe(
            Effect.andThen(() => {
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
            }),
            Effect.andThen(() => {
              // A row that closes live text drops the held chunks: a
              // stream's final text or a card's terminal result drop their
              // own; the run's transcript boundary (the park, the end, the
              // removal) drops every chunk of the run, the same rule the
              // fold applies to its in-flight text, so a card an
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
                event.type === 'run.end' ||
                event.type === 'run.removed' ||
                (event.type === 'flow.step' && event.payload.step === 'waiting')
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
        Effect.tapError((error) =>
          Effect.sync(() =>
            log.error(
              `Session ${key.storage} stopped delivering committed rows: the log could not be read.`,
              { data: error },
            ),
          ),
        ),
        Effect.onExit((exit) => Deferred.done(tailEnded, exit)),
        Effect.forkIn(consumerScope),
      );
      // The registry's phase notification rides the fold-gated tail, not the
      // raw one above: its waiters and child rosters read `RunView.status`
      // synchronously, so a row must reach them only once the view holds the
      // state that row produced.
      yield* Stream.runForEach(session.folded(anchor), (event) =>
        session.receiveFoldedEvent(event),
      ).pipe(
        Effect.tapError((error) =>
          Effect.sync(() =>
            log.error(
              `Session ${key.storage} stopped delivering folded rows: the log could not be read.`,
              { data: error },
            ),
          ),
        ),
        Effect.forkIn(consumerScope),
      );
      yield* sweepLeftoverRuns(session, initialListing).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            log.warn('Background-shell cleanup failed.', {
              data: error,
            }),
          ),
        ),
        Effect.forkScoped,
      );
      // The session owns retries and waits for in-flight removal on close.
      yield* collectPendingDeletions(eventLog, key.storage).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            log.warn(
              'Deletion records could not be read; cleanup remains pending.',
              { data: error },
            );
          }),
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
  return ownerLiveness.pipe(
    Layer.provideMerge(SessionViewService.layer),
    Layer.provideMerge(sessionInputsLayer),
    Layer.provideMerge(runLedgerLayer),
    Layer.provideMerge(
      sessionEventsLayer.pipe(
        Layer.provideMerge(
          databaseLayer(key.open.transcriptMode?.kind ?? 'persistent'),
        ),
      ),
    ),
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
 * handle alone being the entry's service. `Layer.fresh`: the layer map
 * builds every key's entry through one memo map, and layers memoize by
 * reference, so without it the root-scoped layers would be built once and
 * every root on the process would share one log and one fold. The `fresh`
 * covers the sources and the database and nothing above them: every process
 * service the entry reads — the identity first among them, a real effect —
 * comes from the runtime's own context, built once for the process.
 */
const sessionLayer = (
  key: SessionKey,
  held: HeldSessions,
  release: (key: SessionKey) => Effect.Effect<void>,
) =>
  Layer.fresh(
    sessionHandleLayer(key, held, release).pipe(
      Layer.provide(sessionGraphLayer(key)),
    ),
  );

/**
 * The keyed resource family the desktop's N papers and the SDK's N roots
 * need: one session per root, held by the map until `close` releases it
 * or the runtime goes. Opens borrow (the reference an open takes is
 * released at once) and the idle lifetime is infinite, so no reader's
 * detachment and no reference count decides a session's end: the
 * application does, explicitly (PR #11893, agent SDK architecture
 * proposal, section 3).
 */
class Sessions extends Context.Service<
  Sessions,
  LayerMap.LayerMap<SessionKey, Session, SessionOpenError>
>()('@texra/session/Sessions') {
  /** The map, releasing an entry the handle asked to be released through
   *  the runtime that holds the map. */
  static layer(
    held: HeldSessions,
    release: (key: SessionKey) => Effect.Effect<void>,
  ) {
    return Layer.effect(
      Sessions,
      LayerMap.make((key: SessionKey) => sessionLayer(key, held, release), {
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
    Effect.sync(() => {
      log.warn(`Session ${key.storage} failed to open; it holds no session.`, {
        data: error,
      });
      return Option.none();
    });

/** The session held for `root`, if the map holds one: an entry still
 *  building is waited for, never skipped, which is what lets a close issued
 *  right after an open find the session (`SessionOwner.open`). Builds
 *  nothing. The owner's `current` reads the `HeldSessions` map instead: it
 *  answers synchronously and so cannot wait for a build. */
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
 * Close the session of one root (PR #11893, agent SDK architecture
 * proposal, section 9): refuse new runs, stop the root runs it
 * owns (the stop cascades into their children) and the children no root
 * owns any more (a native subagent detached from a stopped parent, between
 * turns), wait for their drivers to settle them inside one budget,
 * flush the session's artifacts while its stores are still open, and
 * release the entry. The budget is the lifecycle's shutdown-phase deadline.
 * Executions
 * that outlive the budget are reported, and the entry stays, refusing new
 * work, until they actually settle; only then is it released, so no later
 * open builds a second session over a root whose stores a run still
 * writes. Nothing here touches the process lifecycle or another root.
 *
 * The whole close is uninterruptible, so the budget above is its one
 * cancellation channel: its first steps (closing admissions and killing the
 * root's runs) cannot be undone and its last (the artifact flush and
 * the entry's release) must still run, so a caller that races or times out
 * this effect must not be able to leave a session shut to new runs, its
 * artifacts unflushed and its entry never released. It does not mask the
 * two races below: `Effect.race` forks its arms interruptible whatever the
 * region around it, so the budget still interrupts the settlement wait and
 * the flush, and the report still returns at the deadline.
 */
const closeSession = (root: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const held = yield* heldSession(root);
    // A root with nothing open: nothing to settle, nothing abandoned.
    if (held === undefined) return { settled: true, abandoned: [] };
    const { key, session, runs } = held;
    // A failed settle travels the defect channel: see the race below.
    const flushArtifacts = session.settlePublications().pipe(Effect.orDie);
    runs.closeAdmissions();
    // Every touch of the session's storage runs in its scope: the stop
    // writes each run's outcome under the session's roots, and the flush
    // writes its stores there. A child with a handle is stopped by its
    // parent's cascade; a native child between turns has no handle, and
    // its kill interrupts the loop the registry retains for it.
    const termination = yield* Effect.forkDetach(
      Effect.all(
        runs.getActiveIds().flatMap((runId) => {
          if (runs.getHandle(runId)?.isChild) return [];
          // A settlement fails when a fact the stop owed storage was
          // refused. `close` answers a `SessionCloseReport` and names no
          // error, so that travels the same defect channel the flush below
          // documents, rather than being widened into this close's type.
          return [
            runs
              .kill(runId, { detachActiveChildren: false })
              .settlement.pipe(Effect.orDie),
          ];
        }),
        { concurrency: 'unbounded', discard: true },
      ),
      { startImmediately: true },
    );
    // The entry remains owned until waiting metadata finalization, not merely
    // handle removal, has completed as well as every live driver.
    const settled = Fiber.join(termination).pipe(
      Effect.andThen(runs.awaitDrained()),
    );
    // One budget for the whole close: the shutdown-phase deadline, forked
    // once so the flush below shares what settlement left.
    const budget = yield* Effect.forkChild(
      Effect.sleep(SHUTDOWN_PHASE_DEADLINE_MS),
    );
    const didSettle = yield* Effect.raceFirst(
      settled.pipe(Effect.as(true)),
      Fiber.join(budget).pipe(Effect.as(false)),
    ).pipe(
      Effect.catchCause((cause) =>
        // A refused stop fact kills the detached termination fiber. The run
        // may still be unwinding, so retain the entry until it settles, then
        // make the same final flush and release the ordinary close path owes.
        // Re-raise the original defect after arming that cleanup so callers
        // still observe the failed close instead of a false success report.
        Effect.forkDetach(
          runs
            .awaitDrained()
            .pipe(
              Effect.andThen(flushArtifacts),
              Effect.ensuring(sessions.invalidate(key)),
            ),
          { startImmediately: true },
        ).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );
    const abandoned = runs.getActiveIds();
    const release = didSettle
      ? sessions.invalidate(key)
      : Effect.sync(() =>
          log.warn(
            `Session ${root} is closing with runs still live past its budget: ${abandoned.join(', ')}; it stays open, refusing new work, until they settle`,
          ),
        ).pipe(
          // Started now, so the wait holds its listener before this close
          // returns and no timer stands between the report and the release.
          Effect.andThen(
            Effect.forkDetach(
              settled.pipe(Effect.andThen(sessions.invalidate(key))),
              { startImmediately: true },
            ),
          ),
        );
    // The release is the flush's finalizer: the entry goes, or its release
    // is armed on the settlement, whatever the flush's exit, and a flush
    // that fails still fails this close.
    //
    // `flushArtifacts` does fail when a session publication failed, and
    // `Effect.orDie` is deliberate rather than an oversight:
    // `close` answers a `SessionCloseReport` and names no error, so the
    // defect is the channel a failed flush travels on, and `ProcessHold.release`
    // (packages/agent/src/effect/runtime.ts) documents the embedder seeing
    // exactly that. Widening it into a typed failure is a contract change,
    // not a conversion.
    yield* Effect.race(
      flushArtifacts,
      Fiber.join(budget).pipe(
        Effect.andThen(
          Effect.sync(() =>
            log.warn(
              `Session ${root}: the artifact flush ran past the close budget and was left to the process teardown`,
            ),
          ),
        ),
      ),
    ).pipe(Effect.ensuring(release));
    const report: SessionCloseReport = {
      settled: didSettle,
      abandoned,
    };
    return report;
  }).pipe(Effect.uninterruptible);

/**
 * Make the one Effect runtime of this process over its identity (PRD 7.7)
 * and install it with the session family it serves: called by a
 * composition root exactly once at startup, right beside `initPlatform()`,
 * which calls {@link disposeProcessRuntime} on its shutdown path after the
 * last session has released its graph. The identity is a program for the
 * process start: already-resolved on a host that read it before installing,
 * still a pending read for a process whose composition root is its first
 * run (the package). It is one of the process services below, so it is read
 * once for the process rather than again per session entry. The owner it
 * installs answers in Effect, on the opener's own fiber; its one
 * synchronous face, `current`, reads the held map and runs nothing.
 *
 * The process services (injection plan §3.1, the one process provide point)
 * are merged here from what the root hands over: `Secrets` and `AppState`
 * over the root's own stores, which every root now opens before it calls
 * this — the desktop and CLI roots open theirs on a bootstrap run rather
 * than on the runtime they are about to install, so both arrive as values
 * (the CLI's secrets-only `clone` entry hands over a store that refuses
 * instead of opening one); `SupabaseAuth` over the root's account plane;
 * `LanguageModel` over the
 * root's editor language-model bridge (`UNAVAILABLE_LANGUAGE_MODEL_PORT`
 * where the host has none); `AgentResume` over the root's own resume port;
 * `SetupPlatform` over the root's host-varying setup capabilities; and
 * `ToolInjections` over `AGENT_TOOL_INJECTIONS`, the same list for every host.
 */
interface ProcessRuntimeOptions {
  readonly processStart: Effect.Effect<string | undefined>;
  readonly globalStorage: string;
  readonly secrets: PlatformSecrets;
  /**
   * The root's agent-resume port, served as `AgentResume`. The same value
   * the root wires into its platform; required of every entry, even one
   * whose port always answers `false` (the agent package's embedder
   * default).
   */
  readonly agentResume: AgentResumePort;
  /**
   * The root's global state store, opened before this install and served as
   * `AppState`. Every entry has one: an entry that serves no application
   * state — the CLI's platform-less `clone`, whose storage root may be
   * read-only — passes a store that refuses instead, so a read or a write
   * of absent state is loud rather than a missing service.
   */
  readonly appState: StateStore;
  /**
   * The root's account plane, served as `SupabaseAuth`. Every shipped host
   * builds one from its secrets; a composition with no TeXRA account plane
   * (the agent package serving an embedder) serves
   * `unavailableSupabaseAuth()`, whose probes answer signed-out.
   */
  readonly auth: SupabaseAuthShape;
  /**
   * The host's editor language-model bridge, served as `LanguageModel`. Every
   * host has a value for it: the VS Code extension's bridge to the editor's
   * language-model API, or `UNAVAILABLE_LANGUAGE_MODEL_PORT` on hosts without
   * one, where discovery discovers nothing.
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
   * The host's Lean language services: the VS Code extension's bridge to the
   * Lean 4 extension, or the direct `lake env lean --server` pool on a Node
   * host, over the `FileSystem`/`Path` this install provides. Built with the
   * runtime and closed when it is disposed.
   */
  readonly lean: Layer.Layer<
    LeanLanguageServices,
    never,
    FileSystem.FileSystem | Path.Path
  >;
}

export function installProcessRuntime({
  processStart,
  globalStorage,
  secrets,
  appState,
  auth,
  languageModel,
  agentResume,
  setup,
  editorModel,
  lean,
}: ProcessRuntimeOptions): ProcessRuntime {
  // Non-failing by contract: `nodeProcesses.selfIdentity()` reports an
  // unreadable identity as undefined, and a root that already read one hands
  // over `Effect.succeed(...)`, which builds this layer synchronously.
  const identity = Layer.effect(
    ProcessIdentity,
    Effect.map(processStart, (start) => ({ ownerId: processOwnerId(start) })),
  );
  // The one handle on the global root, built here and held for the process's
  // life: the records below are `Layer.effect`s over it, and it is provided
  // outside the session family so the entry's `Layer.fresh` cannot rebuild it
  // per root. A global root that will not open is a defect, not a per-record
  // failure: nothing downstream has an answer for it.
  const globalDatabase = globalDatabaseLayer(globalStorage).pipe(
    Layer.provide(identity),
    Layer.orDie,
  );
  const services = Layer.mergeAll(
    inquiryRecordsLayer,
    updateCheckRecordsLayer,
    Secrets.layer(secrets),
    AppState.layer(appState),
    SupabaseAuth.layer(auth),
    LanguageModel.layer(languageModel),
    AgentResume.layer(agentResume),
    SetupPlatform.layer(setup),
    ToolInjections.layer(AGENT_TOOL_INJECTIONS),
    editorModel === undefined
      ? Layer.empty
      : Layer.succeed(EditorModel)(editorModel),
  ).pipe(Layer.provideMerge(identity));
  // The map's services on the caller's own fiber: an Effect-native opener
  // (the SDK) runs these where it stands, so the owner adds no run site of
  // its own. Supply only the owned session family: the caller retains its
  // tracer, logger, and other independently provided services. `current`,
  // the owner's one synchronous face, reads the held map instead.

  const onThisRuntime = <A, E>(
    effect: Effect.Effect<A, E, Sessions>,
  ): Effect.Effect<A, E> =>
    Effect.flatMap(runtime.contextEffect, (context) =>
      Effect.provideService(effect, Sessions, Context.get(context, Sessions)),
    );
  const held: HeldSessions = new Map();
  // A handle's own `dispose` releases its entry here, on the disposing
  // fiber: the release settles when the entry has unwound.
  const release = (key: SessionKey): Effect.Effect<void> =>
    onThisRuntime(Effect.flatMap(Sessions, (s) => s.invalidate(key)));
  const runtime = withForkFailureReporting(
    ManagedRuntime.make(
      Sessions.layer(held, release).pipe(
        Layer.provideMerge(services),
        // The Lean pool is one per process — its servers are shared across
        // roots — as is the cross-workspace storage view below it: every
        // session shares that root, so nothing below resolves a
        // global-storage path against a root of its own.
        Layer.provideMerge(lean),
        Layer.provideMerge(globalStorageFsLayer(globalStorage)),
        // The records' handle on that same root, for the same reason: one
        // connection and one change poll per process, outside the entry.
        Layer.provideMerge(globalDatabase),
        Layer.provideMerge(
          Layer.mergeAll(
            effectDiagnosticsLayer,
            FetchHttpClient.layer,
            // The standard library's filesystem and path services, provided
            // once per process here rather than by each program that needs
            // them: every root reaches this install, so a consumer (the Lean
            // layer included) takes `FileSystem`/`Path` from context and
            // builds no layer of its own.
            NodeFileSystem.layer,
            NodePath.layer,
          ),
        ),
      ),
    ),
  );
  initSessionOwner({
    runtime,
    open: (open) => onThisRuntime(openSession(open)),
    current: (root) => heldSessionSync(held, root),
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
 * finalizers are what release the open sessions, and they still publish
 * while they unwind -- a session's release unwinds the handle and then
 * awaits the publications that teardown left in flight
 * (`SessionHandle.settlePublications`), on the releasing fiber.
 *
 * Idempotent and safe to race: a second call joins the disposal already in
 * flight rather than starting another. The extension's shutdown path runs it
 * as a finalizer (`Effect.ensuring`) and permits a later shutdown, so both
 * happen.
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
