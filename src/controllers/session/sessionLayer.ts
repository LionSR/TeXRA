/**
 * The per-session Effect graph and the process's keyed family of them (PRD
 * one-fold-three-renderers, 7.3 and 7.7). `Sessions` is a `LayerMap`
 * keyed by workspace root: one graph per root and one only, built on the
 * one `ManagedRuntime` each process makes at its entry
 * (`installProcessRuntime`). The root graph holds only root-scoped
 * services: the memory log, the fold, the three local sources, and the
 * owner-liveness prober. What is bound to one `SessionHandle` (its request
 * handler, its transcript bridge, the history import from its transcript
 * store) is built per handle in `sessionGraphOpener`, under a scope the
 * handle closes on dispose, so two handles on one root share the graph and
 * never each other's session.
 *
 * Two pieces of this file exist only until the persistence cutover and are
 * marked so: the hydration importer, which reads the summary tier once per
 * handle and appends the historical streams to the memory log (the only
 * path a historical stream enters the view; the event table replaces it),
 * and the transcript bridge in the opener, which turns the transcript
 * store's change feed into `transcript.entry` rows and in-flight text (the
 * runtime's flow rows replace it).
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
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import pMap from 'p-map';

import { getExecutionStore, readExecutionMetaCore } from '@agent/storage';
import { inspectExecutionLease } from '@agent/storage/executionLease';
import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import {
  ProcessIdentity,
  SessionEventLog,
  SessionEvents,
} from '@agent/runtime/SessionEvents';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
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
import {
  runWithWorkspaceRoots,
  type WorkspaceRoots as HostWorkspaceRoots,
} from '@platform/workspaceRoots';
import {
  AgentCategory,
  USER_FOLLOW_UP_SUPPORT,
  type OwnerId,
  type SessionEventDraft,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import {
  isTerminalOutcomePhase,
  STREAM_TRANSITION_CAUSE,
} from '@shared/streams/streamStatus';
import { isRunningStreamingTextEntry } from '@transcript/StreamLog';
import type { StreamLogStore } from '@transcript/StreamLogStore';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { SessionRequests } from './SessionRequests';
import {
  LocalRuntimeSource,
  ownerProcessStart,
  TextChunkSource,
  TranscriptSubscriptions,
  UNREADABLE_PROCESS_START,
} from './sessionSources';
import { SessionViewService } from './SessionView';
import { WorkspaceRoots } from './WorkspaceRoots';

const log = createLog('sessionLayer');

/** How often the owners the view names are re-probed (PRD 5.2). */
const OWNER_LIVENESS_PROBE_INTERVAL = '5 seconds';

/** How many streams' execution records the importer reads at once. */
const HYDRATION_READ_CONCURRENCY = 8;

/**
 * Which session a graph is of: its workspace roots, equal and hashed by the
 * storage root alone, the value `SessionView.key` carries. Two handles on
 * one root resolve one graph; nothing handle-bound is on the key.
 */
class SessionKey implements Equal.Equal {
  constructor(readonly roots: HostWorkspaceRoots) {}

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

/**
 * The runtime graph of one root (PRD 7.3). `Layer.fresh`: the layer map
 * builds every key's graph through one memo map, and layers memoize by
 * reference, so without it the static service layers would be built once
 * and every root on the process would share one log and one fold.
 */
const sessionLayer = (key: SessionKey) =>
  Layer.fresh(
    ownerLiveness.pipe(
      Layer.provideMerge(SessionViewService.layer),
      Layer.provideMerge(SessionEvents.memoryLayer),
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
  initSessionGraphs(sessionGraphOpener(runtime, ownerId));
  return runtime;
}

/** `${streamId}/${rowId}`: the in-flight text key of one streaming row. */
function inflightKey(streamId: StreamTabId, entry: StreamLogEntry): string {
  return `${streamId}/${entry.id}`;
}

/** One historical stream's rows and the writer they are stamped with. */
interface HistoricalStream {
  readonly drafts: SessionEventDraft[];
  readonly stamp: { readonly ownerId: OwnerId | null; readonly at: number };
}

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
 * Pre-cutover hydration: one historical stream from the summary tier and
 * its execution record. `run.start` carries the summary's identity (nullish
 * where it has none, contract C3), launch config, and description; the
 * execution meta's outcome, when the run finalized, is its terminal
 * `status`. The stamp is the run's historical writer, what the fold's
 * owner rules and the liveness prober need: the lease holder of a run that
 * never finalized (held by another process, or by this one), null for a
 * finalized run and for one nobody holds, which the fold reads as
 * interrupted. Nothing terminal is ever written for a run somebody holds.
 * A summary that names no execution predates the execution mirror and has
 * no record to read; it is reported and skipped rather than given a
 * fabricated execution id.
 */
async function historicalStream(
  session: SessionHandle,
  streamId: StreamTabId,
  self: OwnerId,
): Promise<HistoricalStream | null> {
  const { transcripts } = session;
  const meta = transcripts.getSummaryMeta(streamId);
  if (meta?.executionId === undefined) {
    log.warn(
      `Stream ${streamId} has no execution in its summary; not imported into the session view`,
    );
    return null;
  }
  const { executionId } = meta;
  const known = new Set(transcripts.keys());
  const parent = meta.parentStreamId;
  const drafts: SessionEventDraft[] = [
    {
      type: 'run.start',
      aggregateId: streamId,
      executionId,
      identity: meta.identity ?? null,
      userFollowUpSupport:
        meta.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: meta.agentCategory ?? AgentCategory.ToolUse,
      isRemote: false,
      worktree: null,
      parentStreamId: parent && known.has(parent) ? parent : null,
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
  let ownerId: OwnerId | null = null;
  try {
    await runWithWorkspaceRoots(session.roots, async () => {
      const outcome = (
        await readExecutionMetaCore(getExecutionStore(executionId))
      )?.outcome;
      if (outcome !== undefined) {
        drafts.push({
          type: 'status',
          aggregateId: streamId,
          phase: outcome,
          cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
        });
        return;
      }
      const lease = await inspectExecutionLease(executionId);
      if (lease.status === 'held') {
        ownerId = `${lease.owner.pid}:${lease.owner.processStart ?? UNREADABLE_PROCESS_START}`;
      } else if (lease.status === 'owned') {
        ownerId = self;
      }
    });
  } catch (error) {
    // The record could not be read: the stream is still the user's history,
    // imported with no owner and no outcome, which renders as interrupted.
    log.warn(
      `Execution record of stream ${streamId} (${executionId}) is unreadable; importing it without an outcome: ${toErrorMessage(error)}`,
    );
  }
  return {
    drafts,
    stamp: {
      ownerId,
      at: transcripts.getTimestampRange(streamId).first ?? Date.now(),
    },
  };
}

/**
 * The opener a process installs through `installProcessRuntime`: resolves
 * the graph of the session's root under a scope the session closes on
 * dispose, builds the session-bound services under it, and bridges the
 * session's transcript store into the plane until the cutover (its
 * historical streams once, at open; then every appended or dirtied row as a
 * `transcript.entry` on its stream aggregate, with streaming appends
 * feeding the in-flight text level).
 */
function sessionGraphOpener(
  runtime: ManagedRuntime.ManagedRuntime<Sessions, never>,
  ownerId: OwnerId,
): SessionGraphOpener {
  return (session) => {
    const scope = runtime.runSync(Scope.make());
    const context = runtime.runSync(
      Sessions.contextEffect(new SessionKey(session.roots)).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    const events = Context.get(context, SessionEvents);
    const eventLog = Context.get(context, SessionEventLog);
    const chunks = Context.get(context, TextChunkSource);
    const requests = runtime.runSync(
      Layer.build(SessionRequests.layer(session)).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.map((built) => Context.get(built, SessionRequests)),
      ),
    );
    // The history import (above): the reads are Promise-tier storage reads
    // under the session's own roots, then one ordered append per stream
    // under the log's permit, parents before children.
    runtime.runFork(
      Effect.promise(() =>
        pMap(
          streamsParentsFirst(session.transcripts),
          (streamId) => historicalStream(session, streamId, ownerId),
          { concurrency: HYDRATION_READ_CONCURRENCY },
        ),
      ).pipe(
        Effect.flatMap((streams) =>
          Effect.forEach(
            streams,
            (stream) =>
              stream === null
                ? Effect.void
                : eventLog.appendAll(stream.drafts, stream.stamp),
            { discard: true },
          ),
        ),
      ),
    );
    const detachTranscripts = session.transcripts.onChange(
      (streamId, delta) => {
        const rows = delta.reset
          ? (session.transcripts.get(streamId)?.getRange(0) ?? [])
          : [...delta.appended, ...delta.dirtied];
        if (rows.length > 0) {
          runtime.runFork(
            events.publish(
              rows.map((entry) => ({
                type: 'transcript.entry',
                aggregateId: streamId,
                entry,
              })),
            ),
          );
        }
        if (rows.length === 0 && delta.textChunks.length === 0) return;
        runtime.runFork(
          SubscriptionRef.update(chunks.ref, (held) => {
            const next = new Map(held);
            for (const entry of rows) {
              const key = inflightKey(streamId, entry);
              if (isRunningStreamingTextEntry(entry)) {
                next.set(key, entry.text ?? '');
              } else next.delete(key);
            }
            for (const chunk of delta.textChunks) {
              const key = `${streamId}/${chunk.id}`;
              next.set(key, (next.get(key) ?? '') + chunk.appendText);
            }
            return next;
          }),
        );
      },
    );
    const graph: SessionGraph = {
      events,
      view: Context.get(context, SessionViewService).ref,
      local: Context.get(context, LocalRuntimeSource).ref,
      subscriptions: Context.get(context, TranscriptSubscriptions),
      requests,
      now: () => SubscriptionRef.getUnsafe(eventLog.level),
      close: () => {
        detachTranscripts();
        runtime.runFork(Scope.close(scope, Exit.void));
      },
    };
    return graph;
  };
}
