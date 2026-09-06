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
 * One piece of this file exists only until the persistence cutover and is
 * marked so: the transcript bridge, which turns the root's transcript
 * store's change feed into `transcript.entry` rows and in-flight text (the
 * runtime's flow rows replace it). The historical streams enter the view
 * through the memory log's listing tier (`historicalListing.ts`), read
 * from the summary tier when a reader subscribes; the event table replaces
 * that.
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
  Fiber,
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
  clearProcessRuntime,
  effectRuntime,
  initProcessRuntime,
} from '@platform/processRuntime';
import { SHUTDOWN_PHASE_DEADLINE_MS } from '@platform/defaults/lifecycleHost';
import {
  type OwnerId,
  type SessionCloseReport,
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
          SessionEventLog.memoryLayer(key.open.transcripts, key.open.roots),
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
 * and every root on the process would share one log and one fold. The
 * process identity is provided here, per entry, rather than under the map:
 * the map then builds synchronously, so an open issued while the identity
 * is still being read (the package's) registers its entry with the map
 * before its first yield, and only the entry's build waits.
 */
const sessionLayer = (
  key: SessionKey,
  release: (key: SessionKey) => void,
  identity: Layer.Layer<ProcessIdentity>,
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
    identity: Layer.Layer<ProcessIdentity>,
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
 * proposal, section 9): refuse new executions, stop the root executions it
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
 */
const closeSession = (root: string, signal?: AbortSignal) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const held = yield* heldSession(root);
    if (held === undefined) return NOTHING_TO_CLOSE;
    const { key, session } = held;
    const { executions } = session;
    executions.closeAdmissions();
    // Every touch of the session's storage runs in its scope: the stop
    // writes each run's outcome under the session's roots, and the flush
    // writes its stores there. A child with a handle is stopped by its
    // parent's cascade; a native child between turns has no handle, and
    // its kill interrupts the loop the registry retains for it.
    yield* Effect.sync(() =>
      runInSession(session, () => {
        for (const executionId of executions.getActiveIds()) {
          if (executions.getHandle(executionId)?.isChildExecution) continue;
          executions.kill(executionId, { detachActiveChildren: false });
        }
      }),
    );
    // Ends at the actual settlement, or when interrupted.
    const settled = Effect.promise(
      (interrupt) =>
        runInSession(session, () =>
          untilSettled(executions, interrupt),
        ) as Promise<void>,
    );
    // One budget for the whole close: the caller's signal, else the phase
    // deadline, forked once so the flush below shares what settlement left.
    const budget = yield* Effect.forkChild(
      signal ? aborted(signal) : Effect.sleep(SHUTDOWN_PHASE_DEADLINE_MS),
    );
    yield* Effect.race(settled, Fiber.join(budget));
    const abandoned = executions.getActiveIds();
    const release =
      abandoned.length === 0
        ? sessions.invalidate(key)
        : Effect.sync(() =>
            log.warn(
              `Session ${root} is closing with executions still live past its budget: ${abandoned.join(', ')}; it stays open, refusing new work, until they settle`,
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
      settled: abandoned.length === 0,
      abandoned,
    };
    return report;
  });

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
 * installs is the map's Promise-and-sync face: `open` builds under
 * `runSync`, so everything a root's graph does at build time, the history
 * import included, must complete inside the scheduler's yield budget
 * (`Scheduler.MaxOpsBeforeYield` steps per yield) or the open reads as
 * asynchronous and throws; an opener whose identity is pending opens through
 * `openAsync`. The import appends the whole history in one call for that
 * reason; moving it to row open (#11907) is what removes the history pass
 * from here.
 */
export function installProcessRuntime(
  processStart: string | undefined | Promise<string | undefined>,
): void {
  const identity =
    processStart instanceof Promise
      ? Layer.effect(
          ProcessIdentity,
          Effect.map(
            Effect.promise(() => processStart),
            (start) => ({ ownerId: processOwnerId(start) }),
          ),
        )
      : ProcessIdentity.layer(processOwnerId(processStart));
  const release = (key: SessionKey): void => {
    runtime.runFork(Effect.flatMap(Sessions, (s) => s.invalidate(key)));
  };
  const runtime = ManagedRuntime.make(Sessions.layer(release, identity));
  initProcessRuntime(runtime);
  initSessionOwner({
    open: (open) => runtime.runSync(openSession(open)),
    openAsync: (open) => runtime.runPromise(openSession(open)),
    current: (root) => runtime.runSync(heldSession(root))?.session,
    close: (root, signal) => runtime.runPromise(closeSession(root, signal)),
  });
}

/**
 * Uninstall the session owner and dispose the runtime it ran on, releasing
 * every session still open there: the one shutdown step for both, so a
 * close issued after it answers as a process with no owner does instead of
 * reaching the disposed runtime. The reference goes before the disposal
 * rather than after, so nothing that arrives while the disposal is in
 * flight is handed the runtime that is going away; a process that installs
 * again afterwards -- the CLI re-initializing its platform -- gets a fresh
 * one, because there is no longer one to reuse.
 */
export async function disposeProcessRuntime(): Promise<void> {
  initSessionOwner(undefined);
  const runtime = effectRuntime();
  clearProcessRuntime();
  await runtime.dispose();
}
