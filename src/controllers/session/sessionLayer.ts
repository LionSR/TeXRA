/**
 * The per-session Effect graph and the process's keyed family of them (PRD
 * one-fold-three-renderers, 7.3 and 7.7). `Sessions` is a `LayerMap`
 * keyed by workspace root: one graph per root and one only, built on the
 * one `ManagedRuntime` each process makes at its entry
 * (`installProcessRuntime`). The root graph holds only root-scoped
 * services: the memory log over the root's transcript store, the fold, the
 * three local sources, the owner-liveness prober, and the transcript
 * bridge. What is bound to one `SessionHandle` (its request handler) is
 * built per handle in `sessionGraphOpener`, under a scope the handle closes
 * on dispose, so two handles on one root share the graph and never each
 * other's session.
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
  Effect,
  Equal,
  Exit,
  Hash,
  Layer,
  LayerMap,
  ManagedRuntime,
  Queue,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import {
  ownerProcessStart,
  SessionEventLog,
  sessionEventsLayer,
  tailFrom,
} from '@agent/runtime/SessionEvents';
import {
  initSessionGraphs,
  type SessionGraph,
  type SessionGraphOpener,
} from '@agent/runtime/sessionGraph';
import { createLog } from '@logger/logUtils';
import {
  initProcessRuntime,
  type ProcessRuntime,
} from '@platform/processRuntime';
import type { WorkspaceRoots as HostWorkspaceRoots } from '@platform/workspaceRoots';
import {
  USER_FOLLOW_UP_SUPPORT,
  type OwnerId,
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
import { SessionRequests } from './SessionRequests';
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
 * Which session a graph is of: its workspace roots, equal and hashed by the
 * storage root alone, the value `SessionView.key` carries, together with
 * the root's transcript store, the pre-cutover transcript tier the graph
 * reads and bridges. Two handles on one root resolve one graph, over the
 * store the first of them opened; nothing handle-bound is on the key.
 */
class SessionKey implements Equal.Equal {
  constructor(
    readonly roots: HostWorkspaceRoots,
    readonly transcripts: StreamLogStore,
  ) {}

  [Equal.symbol](that: Equal.Equal): boolean {
    return (
      that instanceof SessionKey && that.roots.storage === this.roots.storage
    );
  }

  [Hash.symbol](): number {
    return Hash.string(this.roots.storage);
  }
}

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
 * The runtime graph of one root (PRD 7.3). `Layer.fresh`: the layer map
 * builds every key's graph through one memo map, and layers memoize by
 * reference, so without it the static service layers would be built once
 * and every root on the process would share one log and one fold.
 */
const sessionLayer = (key: SessionKey) =>
  Layer.fresh(
    Layer.mergeAll(ownerLiveness, transcriptBridge(key.transcripts)).pipe(
      Layer.provideMerge(SessionViewService.layer),
      Layer.provideMerge(sessionInputsLayer),
      Layer.provideMerge(
        sessionEventsLayer.pipe(
          Layer.provideMerge(
            historyImport(key.transcripts).pipe(
              Layer.provideMerge(
                SessionEventLog.memoryLayer(key.transcripts, key.roots),
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
      Layer.provide(Layer.succeed(WorkspaceRoots)(key.roots)),
    ),
  );

/**
 * The keyed resource family the desktop's N papers need: one graph per
 * root, released when the last session holding it closes. No idle window:
 * the memory graph is free to rebuild, and a database connection worth
 * keeping warm arrives with the cutover.
 */
class Sessions extends LayerMap.Service<Sessions>()('@texra/session/Sessions', {
  lookup: (key: SessionKey) => sessionLayer(key),
}) {}

/** The process layer: the session family over the process identity. */
const processLayer = (ownerId: OwnerId) =>
  Sessions.layerNoDeps.pipe(Layer.provide(ProcessIdentity.layer(ownerId)));

/**
 * Make the one Effect runtime of this process over its identity (PRD 7.7)
 * and install it with the session graph family it serves: called by a
 * composition root exactly once at startup, right beside `initPlatform()`,
 * which disposes the returned runtime on its shutdown path after the last
 * session has released its graph.
 */
export function installProcessRuntime(ownerId: OwnerId): ProcessRuntime {
  const runtime = ManagedRuntime.make(processLayer(ownerId));
  initProcessRuntime(runtime);
  initSessionGraphs(sessionGraphOpener(runtime));
  return runtime;
}

/**
 * The opener a process installs through `installProcessRuntime`: resolves
 * the graph of the session's root under a scope the session closes on
 * dispose (building it, history import first, when the session is the
 * root's first) and builds the session-bound services under it.
 */
function sessionGraphOpener(
  runtime: ManagedRuntime.ManagedRuntime<Sessions, never>,
): SessionGraphOpener {
  return (session) => {
    // The build runs under `runSync`, so everything a root's graph does at
    // build time, the history import included, must complete inside the
    // scheduler's yield budget (`Scheduler.MaxOpsBeforeYield` steps per
    // yield) or the open reads as asynchronous and throws. The import
    // appends the whole history in one call for that reason; moving it to
    // row open (#11865) is what removes the history pass from here.
    const scope = runtime.runSync(Scope.make());
    const context = runtime.runSync(
      Sessions.contextEffect(
        new SessionKey(session.roots, session.transcripts),
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    const { publish, ...reads } = Context.get(context, SessionEvents);
    const eventLog = Context.get(context, SessionEventLog);
    const view = Context.get(context, SessionViewService);
    // The request handler admits on the log's sequence table: built under
    // the root graph's context, which holds the log.
    const requests = runtime.runSync(
      Layer.build(SessionRequests.layer(session)).pipe(
        Effect.provide(context),
        Effect.provideService(Scope.Scope, scope),
        Effect.map((built) => Context.get(built, SessionRequests)),
      ),
    );
    const graph: SessionGraph = {
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
      local: Context.get(context, LocalRuntimeSource).ref,
      inputs: Context.get(context, SessionInputs).read,
      subscriptions: Context.get(context, TranscriptSubscriptions),
      requests,
      now: () => SubscriptionRef.getUnsafe(eventLog.level),
      close: () => {
        runtime.runFork(Scope.close(scope, Exit.void));
      },
    };
    return graph;
  };
}
