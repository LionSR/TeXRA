/**
 * The per-session Effect graph and the process's keyed family of them (PRD
 * one-fold-three-renderers, 7.3 and 7.7). `Sessions` is a `LayerMap`
 * keyed by workspace storage root: one session per root and one only,
 * built on the one `ManagedRuntime` each process makes at its entry
 * (`installProcessRuntime`). A root's entry is the complete session: the
 * root-scoped services (the memory log over the root's transcript store,
 * the fold, the three local sources, the owner-liveness prober, and the
 * transcript bridge) and the `SessionHandle` built over them, whose request
 * handler admits on that graph. Every opener (the hosts' default session,
 * the desktop's papers, the SDK) resolves its root here, so opening a root
 * twice returns one handle, and the map is the one owner of its lifetime:
 * an open borrows, `close` settles and releases, and the runtime's disposal
 * releases whatever is still open.
 *
 * Two pieces of this file exist only until the persistence cutover and are
 * marked so: the hydration importer, the first layer of the root graph,
 * which reads the summary tier once per root and seeds the memory log with
 * the historical streams before the plane's anchor is read (the only path a
 * historical stream enters the view; the event table replaces it), and the
 * transcript bridge, which turns the root's transcript store's change feed
 * into `transcript.entry` rows and in-flight text (the runtime's flow rows
 * replace it).
 */
import * as os from 'node:os';

import {
  Context,
  Duration,
  Effect,
  Equal,
  Hash,
  Layer,
  LayerMap,
  ManagedRuntime,
  Option,
  Queue,
  RcMap,
  Stream,
  SubscriptionRef,
} from 'effect';

import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import { runInSession } from '@agent/runtime/RunContext';
import type { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import {
  ownerProcessStart,
  processOwnerId,
  SessionEventLog,
  sessionEventsLayer,
  tailFrom,
} from '@agent/runtime/SessionEvents';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  initSessionOwner,
  type SessionGraph,
  type SessionOpen,
} from '@agent/runtime/sessionGraph';
import { createLog } from '@logger/logUtils';
import {
  initProcessRuntime,
  type ProcessRuntime,
} from '@platform/processRuntime';
import { SHUTDOWN_PHASE_DEADLINE_MS } from '@platform/defaults/lifecycleHost';
import {
  USER_FOLLOW_UP_SUPPORT,
  type OwnerId,
  type SessionCloseReport,
  type SessionEventDraft,
  type StreamTabId,
} from '@shared/schemas';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import type { SessionView } from '@shared/session/sessionView';
import { isTerminalOutcomePhase } from '@shared/streams/streamStatus';
import { SessionInputs } from '@shared/session/sessionInputs';
import {
  isRunningStreamingTextEntry,
  type StreamLogDelta,
} from '@transcript/StreamLog';
import type { StreamLogStore } from '@transcript/StreamLogStore';
import { sessionRequests } from './SessionRequests';
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
 * roots, the root's transcript store the graph reads and bridges, the
 * sidecar store, the response text policy, the host it is born with).
 * Equal and hashed by the storage root alone: two opens of one root resolve
 * one session, over what the first of them supplied. Nothing store-bound
 * can be injected past that boundary (proposal 2026-09-05, section 3).
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

/** The owner ids of the non-terminal streams another process wrote. */
function foreignOwners(view: SessionView, self: OwnerId): OwnerId[] {
  const owners = new Set<OwnerId>();
  for (const stream of view.streams.values()) {
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
 * between changes. Alive and unprovable owners hold their runs (`heldBy`);
 * a dead owner's runs fold to interrupted. It writes only `heldBy`;
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
      const held: OwnerId[] = [];
      for (const owner of owners) {
        const liveness = yield* Effect.promise(() =>
          proveOwnerLiveness({
            pid: Number(owner.slice(0, owner.indexOf(':'))),
            processStart: ownerProcessStart(owner),
            hostname: os.hostname(),
          }),
        );
        if (liveness !== 'dead') held.push(owner);
      }
      const snapshot = yield* SubscriptionRef.get(local.ref);
      if (
        snapshot.heldBy.length === held.length &&
        snapshot.heldBy.every((owner, i) => owner === held[i])
      ) {
        return;
      }
      yield* SubscriptionRef.set(local.ref, { ...snapshot, heldBy: held });
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

/** The summary tier's streams, parents before children and older before
 *  newer, so the fold's creation order is the transcript's: a child folded
 *  before its parent exists is re-rooted for good (PRD 5.2, `ancestors`). */
function streamsParentsFirst(transcripts: StreamLogStore): StreamTabId[] {
  const known = new Set(transcripts.keys());
  let remaining = [...known].sort(
    (a, b) =>
      (transcripts.getTimestampRange(a).first ?? 0) -
      (transcripts.getTimestampRange(b).first ?? 0),
  );
  const ordered: StreamTabId[] = [];
  const placed = new Set<StreamTabId>();
  while (remaining.length > 0) {
    const next = remaining.filter((id) => {
      const parent = transcripts.getSummaryMeta(id)?.parentStreamId;
      return !parent || !known.has(parent) || placed.has(parent);
    });
    if (next.length === 0) {
      // A parent cycle is a corrupt summary tier; import the rest as roots.
      log.warn(
        `Stream summaries form a parent cycle among ${remaining.join(', ')}; importing them as top-level streams`,
      );
      ordered.push(...remaining);
      break;
    }
    for (const id of next) placed.add(id);
    ordered.push(...next);
    remaining = remaining.filter((id) => !placed.has(id));
  }
  return ordered;
}

/**
 * Pre-cutover hydration: one historical stream's facts from the summary
 * tier alone. `run.start` carries the summary's identity (nullish where it
 * has none, contract C3), the launch facts the summary recorded, and the
 * description. The summary holds no status and no holder: a historical
 * stream's outcome is the cutover's event table, or it is not in the
 * listing; nothing here reads an execution record or a lease. A summary
 * that names no execution or no category predates the summary mirror and
 * is reported and skipped rather than given a fabricated launch fact.
 */
function historicalStream(
  transcripts: StreamLogStore,
  streamId: StreamTabId,
): SessionEventDraft[] | null {
  const meta = transcripts.getSummaryMeta(streamId);
  if (meta?.executionId === undefined) {
    log.warn(
      `Stream ${streamId} has no execution in its summary; not imported into the session view`,
    );
    return null;
  }
  if (meta.agentCategory === undefined) {
    log.warn(
      `Stream ${streamId} has no category in its summary; not imported into the session view`,
    );
    return null;
  }
  const { executionId } = meta;
  const parent = meta.parentStreamId;
  const drafts: SessionEventDraft[] = [
    {
      type: 'run.start',
      aggregateId: streamId,
      executionId,
      identity: meta.identity ?? null,
      userFollowUpSupport:
        meta.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: meta.agentCategory,
      isRemote: false,
      worktree: null,
      parentStreamId:
        parent && transcripts.has(parent as StreamTabId) ? parent : null,
    },
  ];
  if (meta.model !== undefined || meta.command !== undefined) {
    drafts.push({
      type: 'run.config',
      aggregateId: streamId,
      executionId,
      config: { model: meta.model, instruction: meta.command },
    });
  }
  if (meta.description) {
    drafts.push({
      type: 'updateStreamDescription',
      aggregateId: streamId,
      description: meta.description,
    });
  }
  return drafts;
}

/**
 * The history import (above): the first layer of a root's graph, the whole
 * history in ONE append under the log's permit, parents before children,
 * each row stamped at its stream's own time, and complete before
 * `sessionEventsLayer` reads its anchor, so the listing hydrate sees every
 * historical stream and the tail starts after them.
 *
 * One call, not one per stream: the graph is built by a synchronous run
 * (`sessionGraphOpener`), and a fiber yields to the scheduler every
 * `Scheduler.MaxOpsBeforeYield` steps, so an import that took the permit
 * and moved the level once per stream crossed that budget on a few
 * thousand streams and the open read as asynchronous. Building the drafts
 * is plain code; the log sees one permit, one array walk, one level move.
 */
const historyImport = (transcripts: StreamLogStore) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const log = yield* SessionEventLog;
      const drafts = streamsParentsFirst(transcripts).flatMap((streamId) => {
        const stream = historicalStream(transcripts, streamId);
        if (stream === null) return [];
        const at = transcripts.getTimestampRange(streamId).last ?? Date.now();
        return stream.map((draft) => ({ ...draft, at }));
      });
      if (drafts.length > 0) yield* log.appendAll(drafts);
    }),
  );

/**
 * The transcript bridge, until the cutover: the root's transcript store's
 * change feed, in emission order, as `transcript.entry` rows on the plane
 * (every appended or dirtied row; every row of a stream whose log was
 * replaced) and as the in-flight text level of its streaming rows. Attached
 * once the plane is built, so the history import precedes every live row.
 */
const transcriptBridge = (transcripts: StreamLogStore) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const events = yield* SessionEvents;
      const chunks = yield* TextChunkSource;
      const deltas = yield* Queue.unbounded<{
        readonly streamId: StreamTabId;
        readonly delta: StreamLogDelta;
      }>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          transcripts.onChange((streamId, delta) => {
            Queue.offerUnsafe(deltas, { streamId, delta });
          }),
        ),
        (detach) => Effect.sync(detach),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(Stream.fromQueue(deltas), ({ streamId, delta }) =>
          Effect.gen(function* () {
            const rows = delta.reset
              ? (transcripts.get(streamId)?.getRange(0) ?? [])
              : [...delta.appended, ...delta.dirtied];
            if (rows.length > 0) {
              yield* events.publish(
                rows.map((entry) => ({
                  type: 'transcript.entry',
                  aggregateId: streamId,
                  entry,
                })),
              );
            }
            if (rows.length === 0 && delta.textChunks.length === 0) return;
            yield* SubscriptionRef.update(chunks.ref, (held) => {
              const next = new Map(held);
              for (const entry of rows) {
                const key = `${streamId}/${entry.id}`;
                if (isRunningStreamingTextEntry(entry)) {
                  next.set(key, entry.text ?? '');
                } else next.delete(key);
              }
              for (const chunk of delta.textChunks) {
                const key = `${streamId}/${chunk.id}`;
                next.set(key, (next.get(key) ?? '') + chunk.appendText);
              }
              return next;
            });
          }),
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
      const eventLog = yield* SessionEventLog;
      const view = yield* SessionViewService;
      const local = yield* LocalRuntimeSource;
      const inputs = yield* SessionInputs;
      const subscriptions = yield* TranscriptSubscriptions;
      const graph = (session: SessionHandle): SessionGraph => ({
        events: reads,
        publish,
        view: view.ref,
        viewChanges: view.changes,
        // The plane's tail woken by the view's cursor instead of the log's
        // level: the same rows `events.all` delivers, none before the fold
        // has landed the state it produced.
        folded: (fromCommit) =>
          tailFrom(
            eventLog.readAll,
            {
              get: SubscriptionRef.get(view.ref).pipe(
                Effect.map((v) => v.cursor),
              ),
              changes: SubscriptionRef.changes(view.ref).pipe(
                Stream.map((v) => v.cursor),
              ),
            },
            fromCommit,
          ),
        local: local.ref,
        inputs: inputs.read,
        subscriptions,
        // The request handler admits on the root graph's log.
        requests: sessionRequests(session, eventLog),
        now: () => SubscriptionRef.getUnsafe(eventLog.level),
        close: () => release(key),
      });
      return yield* Effect.acquireRelease(
        Effect.sync(() => new SessionHandle({ ...key.open, graph })),
        (session) => Effect.sync(() => session.unwind()),
      );
    }),
  );

/** The runtime graph of one root (PRD 7.3): the root-scoped services the
 *  handle is built over. */
const sessionGraphLayer = (key: SessionKey) =>
  Layer.mergeAll(ownerLiveness, transcriptBridge(key.open.transcripts)).pipe(
    Layer.provideMerge(SessionViewService.layer),
    Layer.provideMerge(sessionInputsLayer),
    Layer.provideMerge(
      sessionEventsLayer.pipe(
        Layer.provideMerge(
          historyImport(key.open.transcripts).pipe(
            Layer.provideMerge(
              SessionEventLog.memoryLayer(key.open.transcripts, key.open.roots),
            ),
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

/**
 * The complete session of one root: the handle over the root's graph, the
 * handle alone being the entry's service. `Layer.fresh`: the layer map
 * builds every key's entry through one memo map, and layers memoize by
 * reference, so without it the static service layers would be built once
 * and every root on the process would share one log and one fold.
 */
const sessionLayer = (key: SessionKey, release: (key: SessionKey) => void) =>
  Layer.fresh(
    sessionHandleLayer(key, release).pipe(
      Layer.provide(sessionGraphLayer(key)),
    ),
  );

/**
 * The keyed resource family the desktop's N papers and the SDK's N roots
 * need: one session per root, held by the map until `close` releases it
 * or the runtime goes. Opens borrow (the reference an open takes is
 * released at once) and the idle lifetime is infinite, so no reader's
 * detachment and no reference count decides a session's end: the
 * application does, explicitly (proposal 2026-09-05, section 3).
 */
class Sessions extends Context.Service<
  Sessions,
  LayerMap.LayerMap<SessionKey, Session>
>()('@texra/session/Sessions') {
  /** The map, releasing an entry the handle asked to be released through
   *  the runtime that holds the map. */
  static layer(release: (key: SessionKey) => void) {
    return Layer.effect(
      Sessions,
      LayerMap.make((key: SessionKey) => sessionLayer(key, release), {
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

/** Resolve once every execution the registry holds has left it. Detaches
 *  on `signal`, so a bounded wait leaves no listener behind. */
async function untilSettled(
  executions: ExecutionRegistry,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    const active = executions.getActiveIds();
    if (active.length === 0 || signal.aborted) return;
    await executions.waitForAnyChange(active, signal);
  }
}

/**
 * Close the session of one root (proposal 2026-09-05, section 9): refuse
 * new executions, stop the root executions it owns (the stop cascades into
 * their children), wait for their drivers to settle them inside the
 * lifecycle's phase budget, flush the session's artifacts while its stores
 * are still open, and release the entry. Executions that outlive the
 * budget are reported, and the entry stays, refusing new work, until they
 * actually settle; only then is it released, so no later open builds a
 * second session over a root whose stores a run still writes. Nothing here
 * touches the process lifecycle or another root.
 */
const closeSession = (root: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const keys = yield* RcMap.keys(sessions.rcMap);
    const key = [...keys].find((candidate) => candidate.storage === root);
    if (key === undefined) return { settled: true, abandoned: [] };
    const held = yield* sessions.contextEffectOption(key).pipe(Effect.scoped);
    if (Option.isNone(held)) return { settled: true, abandoned: [] };
    const session = Context.get(held.value, Session);
    const { executions } = session;
    executions.closeAdmissions();
    // Every touch of the session's storage runs in its scope: the stop
    // writes each run's outcome under the session's roots, and the flush
    // writes its stores there.
    yield* Effect.sync(() =>
      runInSession(session, () => {
        for (const executionId of executions.getActiveIds()) {
          if (executions.getHandle(executionId)?.isChildExecution) continue;
          executions.kill(executionId, { detachActiveChildren: false });
        }
      }),
    );
    const settled = Effect.promise(
      (signal) =>
        runInSession(session, () =>
          untilSettled(executions, signal),
        ) as Promise<void>,
    );
    yield* settled.pipe(Effect.timeoutOption(SHUTDOWN_PHASE_DEADLINE_MS));
    const abandoned = executions.getActiveIds();
    yield* Effect.promise(
      () =>
        runInSession(session, () => session.flushArtifacts()) as Promise<void>,
    );
    const release = sessions.invalidate(key);
    if (abandoned.length === 0) {
      yield* release;
    } else {
      log.warn(
        `Session ${root} is closing with executions still live past the ${SHUTDOWN_PHASE_DEADLINE_MS}ms budget: ${abandoned.join(', ')}; it stays open, refusing new work, until they settle`,
      );
      // Started now, so the wait holds its listener before this close
      // returns and no timer stands between the report and the release.
      yield* Effect.forkDetach(settled.pipe(Effect.andThen(release)), {
        startImmediately: true,
      });
    }
    const report: SessionCloseReport = {
      settled: abandoned.length === 0,
      abandoned,
    };
    return report;
  });

/**
 * Make the one Effect runtime of this process over its identity (PRD 7.7)
 * and install it with the session family it serves: called by a
 * composition root exactly once at startup, right beside `initPlatform()`,
 * which disposes the returned runtime on its shutdown path after the last
 * session has released its graph. The owner it installs is the map's
 * Promise-and-sync face: `open` builds under `runSync`, so everything a
 * root's graph does at build time, the history import included, must
 * complete inside the scheduler's yield budget (`Scheduler.MaxOpsBeforeYield`
 * steps per yield) or the open reads as asynchronous and throws. The import
 * appends the whole history in one call for that reason; moving it to row
 * open (#11907) is what removes the history pass from here.
 */
export function installProcessRuntime(
  processStart: string | undefined,
): ProcessRuntime {
  const release = (key: SessionKey): void => {
    runtime.runFork(Effect.flatMap(Sessions, (s) => s.invalidate(key)));
  };
  const runtime = ManagedRuntime.make(
    Sessions.layer(release).pipe(
      Layer.provide(ProcessIdentity.layer(processOwnerId(processStart))),
    ),
  );
  initProcessRuntime(runtime);
  initSessionOwner({
    open: (open) => runtime.runSync(openSession(open)),
    close: (root) => runtime.runPromise(closeSession(root)),
  });
  return runtime;
}
