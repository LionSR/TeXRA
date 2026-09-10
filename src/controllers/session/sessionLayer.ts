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
 * transcript store and its snapshot store over that log and hands both to
 * the handle. Every opener (the hosts' default session,
 * the desktop's papers, the SDK) resolves its root here, so opening a root
 * twice returns one handle, and the map is the one owner of its lifetime:
 * an open borrows, `close` settles and releases, and the runtime's disposal
 * releases whatever is still open.
 */
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
} from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import { runInSession } from '@agent/runtime/RunContext';
import type { RunRegistry } from '@agent/runtime/runRegistry';
import { sessionEventsLayer, tailFrom } from '@agent/runtime/SessionEvents';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  initSessionOwner,
  type SessionGraph,
  type SessionOpen,
} from '@agent/runtime/sessionGraph';
import { createLog } from '@logger/logUtils';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import {
  clearProcessRuntime,
  initProcessRuntime,
  tryProcessRuntime,
} from '@platform/processRuntime';
import { processOwnerId } from '@platform/defaults/nodeProcesses';
import { SHUTDOWN_PHASE_DEADLINE_MS } from '@platform/defaults/lifecycleHost';
import {
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  isDisplaySessionEvent,
  ownerIdentity,
  type OwnerId,
  type SessionCloseReport,
  type SessionEvent,
} from '@shared/schemas';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import type { SessionView } from '@shared/session/sessionView';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { SessionInputs } from '@shared/session/sessionInputs';

import { Database } from '@shared/session/database';
import { StreamLogStore } from '@transcript/StreamLogStore';
import { RunSnapshotStore } from '@transcript/RunSnapshotStore';
import { inquiryRecordsLayer } from './inquiryRecords';
import { updateCheckRecordsLayer } from './updateCheckRecords';
import { databaseLayer } from './Database';
import { collectPendingDeletions } from './deletionCleanup';
import { sessionRequests } from './SessionRequests';
import { sweepLeftoverRuns } from './sweepLeftoverRuns';
import { applyCommittedRunRemoval } from './applyCommittedRunRemoval';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
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
  constructor(readonly open: SessionOpen) {}

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

/** The owner ids of the non-terminal runs another process wrote. */
function foreignOwners(view: SessionView, self: OwnerId): OwnerId[] {
  const owners = new Set<OwnerId>();
  for (const stream of view.runs.values()) {
    if (
      stream.ownerId !== null &&
      stream.ownerId !== self &&
      !isTerminalOutcomePhase(stream.status)
    ) {
      owners.add(stream.ownerId);
    }
  }
  return [...owners].sort();
}

/**
 * The liveness prober (PRD 5.2, contract C5): every owner the view names
 * on a non-terminal stream other than this process, proved by
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
        // The one thing `proveOwnerLiveness` awaits is
        // `ProcessesPort.identity`, declared `Promise<string | undefined>`
        // with unreadable meaning undefined, and the `kill(pid, 0)` beside it
        // catches its own throw. A rejection here would end this prober's
        // stream for the life of the process, so that total contract is the
        // thing to keep. Note `Database.ts` wraps the same call in
        // `Effect.tryPromise` with a `writeFailed` catch: there the caller has
        // an error channel to put a failure in, here it has none.
        const liveness = yield* Effect.promise(() =>
          proveOwnerLiveness(ownerIdentity(owner)),
        );
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
 * The handle of one root, over the root's graph: the last layer of the
 * entry, so it is the first thing unwound when the entry closes and the
 * graph outlives every publisher above it. Every release goes through the
 * entry: `close` and the runtime's disposal invalidate it, and the handle's
 * own `dispose` asks for the same through `graph.close`.
 */
const sessionHandleLayer = (
  key: SessionKey,
  release: (key: SessionKey) => void,
) =>
  Layer.effect(
    Session,
    Effect.gen(function* () {
      const { publish, ...reads } = yield* SessionEvents;
      const eventLog = yield* Database;
      const inquiryRecords = yield* InquiryRecords;
      const view = yield* SessionViewService;
      const local = yield* LocalRuntimeSource;
      const inputs = yield* SessionInputs;
      const chunks = yield* TextChunkSource;
      const subscriptions = yield* TranscriptSubscriptions;
      const delivered = yield* SubscriptionRef.make(0);
      const tailEnded = yield* Deferred.make<void>();
      const settledCursor = () =>
        Math.min(
          SubscriptionRef.getUnsafe(view.ref).cursor,
          SubscriptionRef.getUnsafe(delivered),
        );
      const settlePublication = (rows: readonly SessionEvent[]) =>
        Effect.gen(function* () {
          const last = rows.at(-1);
          if (last) {
            yield* SubscriptionRef.changes(delivered).pipe(
              Stream.filter((commit) => commit >= last.commit),
              Stream.runHead,
              Effect.raceFirst(
                Deferred.await(tailEnded).pipe(
                  Effect.andThen(
                    Effect.die(
                      new Error('Session committed-event consumer stopped'),
                    ),
                  ),
                ),
              ),
            );
          }
          if (last) {
            yield* view.changes.pipe(
              Stream.filter((state) => state.cursor >= last.commit),
              Stream.runHead,
              Effect.flatMap((state) =>
                Option.isSome(state)
                  ? Effect.void
                  : Effect.die(
                      new Error(
                        'Session view stopped before publication settled',
                      ),
                    ),
              ),
            );
          }
          return rows;
        });
      const graph = (session: SessionHandle): SessionGraph => ({
        events: reads,
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
        acquireRunClaims: (runId) =>
          eventLog.acquireClaims([qualifyAggregateId('run', runId)]).pipe(
            Effect.map((ids) => eventLog.releaseClaims(ids).pipe(Effect.orDie)),
            Effect.orDie,
          ),
        releaseRunClaims: (runId) =>
          eventLog
            .releaseClaims([qualifyAggregateId('run', runId)])
            .pipe(Effect.orDie),
        runRecords: (id) =>
          eventLog
            .readRunRecords(qualifyAggregateId('run', id))
            .pipe(Effect.orDie),
        runChildren: (id) =>
          eventLog
            .readRunChildren(qualifyAggregateId('run', id))
            .pipe(Effect.orDie),
        recordListing: () => eventLog.readListing().pipe(Effect.orDie),
        publish: (events) =>
          publish(events).pipe(Effect.flatMap(settlePublication)),
        publishRegistration: (events) =>
          Effect.gen(function* () {
            const rows = yield* publish(events);
            const born = rows.flatMap((row) =>
              row.type === 'run.start' ? [row.aggregateId] : [],
            );
            return yield* settlePublication(rows).pipe(
              Effect.onError(() =>
                eventLog.releaseClaims(born).pipe(Effect.orDie),
              ),
            );
          }),
        view: view.ref,
        viewChanges: view.changes,
        // Release rows only once both the view fold and local reconciliation
        // have applied them. Readers can then query either state consistently.
        folded: (fromCommit) =>
          tailFrom(
            (from) =>
              Stream.fromIterableEffect(
                eventLog.readAll(from).pipe(Effect.orDie),
              ).pipe(Stream.filter(isDisplaySessionEvent)),
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
        // The request handler admits on the root graph's log.
        requests: sessionRequests(session, eventLog, local.ref, inquiryRecords),
        now: () => SubscriptionRef.getUnsafe(eventLog.observedCommit),
        close: () => release(key),
      });
      // Capture before constructing the handle: constructor publications and
      // commits preceding subscription are covered by the tail's first read.
      const anchor = yield* eventLog.currentCommit.pipe(Effect.orDie);
      // Register the consumer's scope first so handle teardown can publish and
      // drain while both this tail and the underlying view are still alive.
      const consumerScope = yield* Effect.acquireRelease(
        Scope.make(),
        (scope, exit) => Scope.close(scope, exit),
      );
      // Capture the startup cohort before callers can publish new launches.
      const initialListing = yield* eventLog.readListing().pipe(Effect.orDie);
      const transcripts = yield* StreamLogStore.open(
        eventLog,
        initialListing,
        key.open.transcriptMode,
      ).pipe(Effect.orDie);
      const session = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new SessionHandle({
              ...key.open,
              transcripts,
              snapshots: new RunSnapshotStore(eventLog),
              graph,
            }),
        ),
        (session) =>
          Effect.sync(() => session.unwind()).pipe(
            // Settlement reports what the session's own publications left
            // behind. The release still has to finish, so that report is
            // logged here rather than escaping `Scope.close` and failing the
            // `invalidate` or `close` that asked for the release.
            Effect.ensuring(
              Effect.tryPromise({
                try: () => session.settlePublications(),
                catch: (error) => error,
              }).pipe(
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
      yield* SubscriptionRef.set(delivered, anchor);
      yield* reads.all(anchor, delivered).pipe(
        Stream.runForEach((event) =>
          session.receiveCommittedEvent(event).pipe(
            Effect.andThen(() => {
              const target = aggregateTarget(event.aggregateId);
              return event.type === 'run.removed' && target.kind === 'run'
                ? applyCommittedRunRemoval(session, target.id)
                : Effect.void;
            }),
            Effect.andThen(
              event.type === 'stream.end'
                ? SubscriptionRef.update(chunks.ref, (held) => {
                    const next = new Map(held);
                    next.delete(
                      `${aggregateTarget(event.aggregateId).id}/${event.id}`,
                    );
                    return next;
                  })
                : Effect.void,
            ),
            Effect.andThen(SubscriptionRef.set(delivered, event.commit)),
          ),
        ),
        Effect.onExit((exit) => Deferred.done(tailEnded, exit)),
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
      return session;
    }),
  );

/** The runtime graph of one root (PRD 7.3): the root-scoped services the
 *  handle is built over. */
const sessionGraphLayer = (key: SessionKey) => {
  return ownerLiveness.pipe(
    Layer.provideMerge(SessionViewService.layer),
    Layer.provideMerge(sessionInputsLayer),
    Layer.provideMerge(
      sessionEventsLayer.pipe(
        Layer.provideMerge(
          databaseLayer(key.open.transcriptMode?.kind ?? 'persistent').pipe(
            Layer.orDie,
          ),
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
 * reference, so without it the static service layers would be built once
 * and every root on the process would share one log and one fold. The
 * process identity is provided here, per entry, rather than under the map:
 * the map then builds synchronously, so an open issued while the identity
 * is still being read (the package's) registers its entry with the map
 * before its first yield, and only the entry's build waits.
 */
const sessionLayer = (
  key: SessionKey,
  release: (key: SessionKey) => void,
  identity: Layer.Layer<ProcessIdentity | InquiryRecords>,
) =>
  Layer.fresh(
    sessionHandleLayer(key, release).pipe(
      Layer.provide(sessionGraphLayer(key)),
      Layer.provide(identity),
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
  LayerMap.LayerMap<SessionKey, Session>
>()('@texra/session/Sessions') {
  /** The map, releasing an entry the handle asked to be released through
   *  the runtime that holds the map. */
  static layer(
    release: (key: SessionKey) => void,
    identity: Layer.Layer<ProcessIdentity | InquiryRecords>,
  ) {
    return Layer.effect(
      Sessions,
      LayerMap.make((key: SessionKey) => sessionLayer(key, release, identity), {
        idleTimeToLive: Duration.infinity,
      }),
    );
  }
}

/** The session of `open`'s root: built now, or the one already open. A
 *  build that fails leaves no entry behind (the map would otherwise answer
 *  every later open of the root with the cached failure). */
const openSession = (open: SessionOpen) =>
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
    const entry = yield* sessions.contextEffectOption(key).pipe(Effect.scoped);
    if (Option.isSome(entry)) held.push(Context.get(entry.value, Session));
  }
  return held;
});

/** The session held for `root`, if the map holds one: an entry still
 *  building is waited for, never skipped. Builds nothing. */
const heldSession = (root: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const keys = yield* RcMap.keys(sessions.rcMap);
    const key = [...keys].find((candidate) => candidate.storage === root);
    if (key === undefined) return undefined;
    const held = yield* sessions.contextEffectOption(key).pipe(Effect.scoped);
    return Option.isNone(held)
      ? undefined
      : { key, session: Context.get(held.value, Session) };
  });

/**
 * Resolve once every run the registry holds has left it. Interrupting
 * this fiber — which is what the close budget below does — detaches the
 * registry listeners with it, so a bounded wait leaves none behind. The
 * registry state is re-read once those listeners are attached, closing the
 * window between the read below and a registration the fiber only reaches a
 * scheduler step later: `raceAllFirst` starts its arms immediately and in
 * order, so the wait registers first and the re-check then sees a last
 * run that left inside the window, instead of waiting out the whole
 * close budget for a notification that can no longer come. The loop reads
 * registry state only, so it needs no session scope of its own.
 */
const untilSettled = (runs: RunRegistry): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (;;) {
      const active = runs.getActiveIds();
      if (active.length === 0) return;
      const alreadySettled = Effect.suspend(() =>
        runs.getActiveIds().length === 0 ? Effect.void : Effect.never,
      );
      yield* Effect.raceAllFirst([
        runs.waitForAnyChange(active).pipe(Effect.asVoid),
        alreadySettled,
      ]);
    }
  });

/** A root with nothing open: nothing to settle, nothing abandoned. */
const NOTHING_TO_CLOSE: SessionCloseReport = { settled: true, abandoned: [] };

/** Resolves once `signal` aborts; interrupting it detaches the listener. */
const aborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume, interrupt) => {
    if (signal.aborted) return resume(Effect.void);
    signal.addEventListener('abort', () => resume(Effect.void), {
      once: true,
      signal: interrupt,
    });
  });

/**
 * Close the session of one root (PR #11893, agent SDK architecture
 * proposal, section 9): refuse new runs, stop the root runs it
 * owns (the stop cascades into their children) and the children no root
 * owns any more (a native subagent detached from a stopped parent, between
 * turns), wait for their drivers to settle them inside one budget,
 * flush the session's artifacts while its stores are still open, and
 * release the entry. The budget is the caller's `signal` when it passes one
 * (the lifecycle's shutdown phase, whose deadline started before this
 * close), the lifecycle's phase deadline otherwise: never both. Executions
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
const closeSession = (root: string, signal?: AbortSignal) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const held = yield* heldSession(root);
    if (held === undefined) return NOTHING_TO_CLOSE;
    const { key, session } = held;
    const { runs } = session;
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
          return [
            runs.kill(runId, { detachActiveChildren: false })
              .settlement,
          ];
        }),
        { concurrency: 'unbounded', discard: true },
      ),
      { startImmediately: true },
    );
    // The entry remains owned until waiting metadata finalization, not merely
    // handle removal, has completed as well as every live driver.
    const settled = Fiber.join(termination).pipe(
      Effect.andThen(untilSettled(runs)),
    );
    // One budget for the whole close: the caller's signal, else the phase
    // deadline, forked once so the flush below shares what settlement left.
    const budget = yield* Effect.forkChild(
      signal ? aborted(signal) : Effect.sleep(SHUTDOWN_PHASE_DEADLINE_MS),
    );
    const didSettle = yield* Effect.race(
      settled.pipe(Effect.as(true)),
      Fiber.join(budget).pipe(Effect.as(false)),
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
    // `flushArtifacts` does reject when a session publication failed, and
    // `Effect.promise` is deliberate rather than an oversight:
    // `close` answers a `SessionCloseReport` and names no error, so the
    // defect is the channel a failed flush travels on, and `ProcessHold.release`
    // (packages/agent/src/effect/runtime.ts) documents the embedder seeing
    // exactly that. Widening it into a typed failure is a contract change,
    // not a conversion.
    yield* Effect.race(
      Effect.promise(
        () =>
          runInSession(session, () =>
            session.flushArtifacts(),
          ) as Promise<void>,
      ),
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
 * last session has released its graph. The identity is the process start
 * a host read before installing, or its pending read for a process whose
 * composition root is its first run (the package): the map itself never
 * waits for it, so an open registers its root with the owner before the
 * caller's first await, and only the entry's build does. The owner it
 * installs answers in Effect except for the two synchronous faces the
 * unconverted hosts still take: `openSync` builds under `runSync`, so
 * everything a root's graph does at build time (opening the database,
 * reading the startup listing, opening the transcript store) must complete
 * inside the scheduler's yield budget (`Scheduler.MaxOpsBeforeYield` steps
 * per yield) or the open reads as asynchronous and throws; an opener whose
 * identity is still pending opens through the Effect face.
 */
export function installProcessRuntime(
  processStart: string | undefined | Promise<string | undefined>,
  globalStorage: () => string,
  updateCheckStorage: () => string,
): void {
  const identity =
    processStart instanceof Promise
      ? Layer.effect(
          ProcessIdentity,
          Effect.map(
            // Non-rejecting by port contract: the one caller that passes a
            // pending read passes `ProcessesPort.selfIdentity()`, declared as
            // `string | undefined`, unreadable being undefined.
            Effect.promise(() => processStart),
            (start) => ({ ownerId: processOwnerId(start) }),
          ),
        )
      : ProcessIdentity.layer(processOwnerId(processStart));
  const services = Layer.merge(
    inquiryRecordsLayer(globalStorage),
    updateCheckRecordsLayer(updateCheckStorage),
  ).pipe(Layer.provideMerge(identity));
  const release = (key: SessionKey): void => {
    runtime.runFork(Effect.flatMap(Sessions, (s) => s.invalidate(key)));
  };
  const runtime = ManagedRuntime.make(
    Sessions.layer(release, services).pipe(
      Layer.provideMerge(services),
      Layer.provideMerge(
        Layer.mergeAll(effectDiagnosticsLayer, FetchHttpClient.layer),
      ),
    ),
  );
  initProcessRuntime(runtime);
  // The map's services on the caller's own fiber: an Effect-native opener
  // (the SDK) runs these where it stands, so the owner adds no run site of
  // its own. Supply only the owned session family: the caller retains its
  // tracer, logger, and other independently provided services. `openSync`
  // and `current` stay synchronous for the three hosts.
  const onThisRuntime = <A, E>(
    effect: Effect.Effect<A, E, Sessions>,
  ): Effect.Effect<A, E> =>
    Effect.flatMap(runtime.contextEffect, (context) =>
      Effect.provideService(effect, Sessions, Context.get(context, Sessions)),
    );
  initSessionOwner({
    openSync: (open) => runtime.runSync(openSession(open)),
    open: (open) => onThisRuntime(openSession(open)),
    current: (root) => runtime.runSync(heldSession(root))?.session,
    list: () => onThisRuntime(listSessions),
    close: (root, signal) => onThisRuntime(closeSession(root, signal)),
  });
}

/**
 * Uninstall the session owner and dispose the runtime it ran on, releasing
 * every session still open there: the one shutdown step for both, so a close
 * issued after it answers as a process with no owner does instead of reaching
 * the disposed runtime.
 *
 * The runtime stays reachable for the whole of its own disposal. Its layer
 * finalizers are what release the open sessions, and they still publish
 * through `effectRuntime()` while they unwind -- `SessionHandle.unwind()`
 * disposes pending host interactions, whose `approval.resolved` facts go out
 * through `SessionHandle.publish`, which forks on this very runtime. Clearing
 * the reference first made those finalizers throw "not initialized" mid
 * shutdown. It is cleared afterwards, and only if this runtime is still the
 * installed one, so a replacement installed while this one unwound survives.
 *
 * Idempotent and safe to race: an absent runtime needs no disposal, and a
 * second call joins the disposal already in flight rather than reaching a
 * throwing accessor. The extension's shutdown path calls it from a `finally`
 * and permits a later shutdown, so both happen.
 */
let disposal: Promise<void> | null = null;

export function disposeProcessRuntime(): Promise<void> {
  if (disposal) return disposal;
  const runtime = tryProcessRuntime();
  if (!runtime) return Promise.resolve();
  initSessionOwner(undefined);
  disposal = runtime
    .dispose()
    .finally(() => {
      clearProcessRuntime(runtime);
      disposal = null;
    })
    .then(() => undefined);
  return disposal;
}
