/** Resident transcript entries, hydrated from the session's event table. */
import { Effect, Semaphore, type Context } from 'effect';

import {
  aggregateId,
  aggregateTarget,
  isTranscriptEvent,
  type SessionEvent,
  type RunId,
} from '@shared/schemas';
import type { Database } from '@shared/session/database';
import { StreamLog } from '@shared/session/traceEntries';
import { createTranscriptFold } from '@shared/session/traceFold';

type TranscriptDatabase = Pick<
  Context.Service.Shape<typeof Database>,
  'readAggregate' | 'readListing'
>;
export type StreamLogStoreMode =
  | { readonly kind: 'persistent' }
  | { readonly kind: 'ephemeral'; readonly reason: string };

interface RunOwnership {
  readonly ownerKey: string;
  readonly tokens: Set<symbol>;
}
type TranscriptResidencyLeaseReason = 'run' | 'focus';
export interface TranscriptResidencyLease {
  readonly runId: RunId;
  close(): void;
}
interface RunState {
  log?: StreamLog;
  fold?: ReturnType<typeof createTranscriptFold>;
  seq?: number;
  pins?: Set<TranscriptResidencyLeaseReason>;
  runOwner?: RunOwnership;
}

/** Apply one event with the same projection used by the live recorder. */
function applyEvent(
  log: StreamLog,
  fold: ReturnType<typeof createTranscriptFold>,
  event: SessionEvent,
): void {
  if (event.type === 'transcript.entry') log.record(event.entry);
  else if (event.type === 'status') fold.status(event.phase);
  else if (event.type === 'run.end') fold.status(event.outcome);
  else if (isTranscriptEvent(event))
    fold.record(event, {
      at: event.at,
      id: JSON.stringify([event.aggregateId, event.seq]),
      debug: event.transcriptDebug ?? false,
    });
}

function foldEntries(events: readonly SessionEvent[]): RunState | undefined {
  if (events.length === 0 || events.at(-1)?.type === 'run.removed') return;
  if (events[0]?.type !== 'run.start' || events[0].seq !== 1) {
    throw new Error('A transcript read must begin with its creation row.');
  }
  const entries = new StreamLog();
  const fold = createTranscriptFold(entries);
  for (const event of events) applyEvent(entries, fold, event);
  entries.drainEmission();
  return { log: entries, fold, seq: events.at(-1)!.seq };
}

export class StreamLogStore {
  private readonly runs = new Map<RunId, RunState>();
  private readonly known = new Set<RunId>();
  private readonly releaseRequests = new Set<RunId>();
  private readonly gate = Semaphore.makeUnsafe(1);

  private constructor(
    readonly mode: StreamLogStoreMode,
    private readonly database: TranscriptDatabase,
  ) {}

  /** Construct the root's resident store from its indexed existence facts. */
  static open(
    database: TranscriptDatabase,
    listing?: readonly SessionEvent[],
    mode: StreamLogStoreMode = { kind: 'persistent' },
  ) {
    return Effect.gen(function* () {
      const store = new StreamLogStore(mode, database);
      for (const event of listing ?? (yield* database.readListing())) {
        const target = aggregateTarget(event.aggregateId);
        if (target.kind !== 'run') continue;
        const id = target.id;
        if (event.type === 'run.start') store.known.add(id);
        else if (event.type === 'run.removed') store.known.delete(id);
      }
      return store;
    });
  }

  get(runId: RunId): StreamLog | undefined {
    return this.runs.get(runId)?.log;
  }
  has(runId: RunId): boolean {
    return this.known.has(runId);
  }

  /** Read a complete event prefix without changing residency. */
  readEntries(runId: RunId) {
    return this.database
      .readAggregate(aggregateId('run', runId), 0)
      .pipe(Effect.map((events) => foldEntries(events)?.log?.toJSON() ?? []));
  }

  hasAuthoritativeRun(runId: RunId) {
    return this.database
      .readAggregate(aggregateId('run', runId), 0)
      .pipe(
        Effect.map(
          (events) =>
            events.length > 0 && events.at(-1)?.type !== 'run.removed',
        ),
      );
  }

  requestEviction(runId: RunId): void {
    if (this.mode.kind === 'ephemeral') return;
    this.releaseRequests.add(runId);
    const state = this.runs.get(runId);
    if (state) this.unpin(state, 'focus');
    this.tryRelease(runId);
  }

  /** Retain a run's transcript for the run itself: the run is its own owner key. */
  acquireRunResidency(runId: RunId) {
    return this.gate.withPermit(
      Effect.gen({ self: this }, function* () {
        const residency = this.retainRun(runId, runId);
        yield* this.loadEntries(runId).pipe(
          Effect.onError(() => Effect.sync(() => residency.close())),
        );
        return residency;
      }),
    );
  }

  ensureLoaded(runId: RunId): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      this.acquireLease(runId, 'focus');
      this.releaseRequests.delete(runId);
      yield* this.gate.withPermit(this.loadEntries(runId));
    });
  }

  private loadEntries(runId: RunId) {
    return Effect.gen({ self: this }, function* () {
      if (this.get(runId) !== undefined) return;
      const entries = foldEntries(
        yield* this.database.readAggregate(aggregateId('run', runId), 0),
      );
      if (entries === undefined) {
        this.known.delete(runId);
        return;
      }
      this.known.add(runId);
      Object.assign(this.ensureRunState(runId), entries);
    });
  }

  /** Apply the ordered committed tail under the same permit as cold hydration. */
  acceptCommitted(event: SessionEvent) {
    return this.gate.withPermit(
      Effect.sync(() => {
        const target = aggregateTarget(event.aggregateId);
        if (target.kind !== 'run') return;
        const runId = target.id;
        if (event.type === 'run.start') this.known.add(runId);
        if (event.type === 'run.removed') {
          this.runs.delete(runId);
          this.known.delete(runId);
          this.releaseRequests.delete(runId);
          return;
        }
        const state = this.runs.get(runId);
        if (
          state === undefined ||
          (state.log === undefined && state.runOwner === undefined)
        )
          return;
        // Hydration may already include this tail row. Aggregate sequence is
        // the prefix boundary, independent of when its wake was delivered.
        if (event.seq <= (state.seq ?? 0)) return;
        state.log ??= new StreamLog();
        state.fold ??= createTranscriptFold(state.log);
        applyEvent(state.log, state.fold, event);
        state.seq = event.seq;
        // Nothing here reads the log's change buffers; drain them so they do
        // not grow with the resident log.
        state.log.drainEmission();
      }),
    );
  }

  private retainRun(runId: RunId, ownerKey: string): TranscriptResidencyLease {
    if (!ownerKey.trim()) {
      throw new Error(
        'Transcript run residency requires a non-empty owner key.',
      );
    }

    const current = this.runs.get(runId)?.runOwner;
    if (current && current.ownerKey !== ownerKey) {
      throw new Error(
        `Transcript run ${runId} is already owned by another run.`,
      );
    }
    const ownership =
      current ?? ({ ownerKey, tokens: new Set() } satisfies RunOwnership);
    const token = Symbol(ownerKey);
    ownership.tokens.add(token);
    const runState = this.ensureRunState(runId);
    runState.runOwner = ownership;
    this.acquireLease(runId, 'run');
    let closed = false;

    return {
      runId,
      close: () => {
        if (closed) return;
        closed = true;
        const state = this.runs.get(runId);
        if (!state || state.runOwner !== ownership) return;
        ownership.tokens.delete(token);
        if (ownership.tokens.size > 0) return;
        state.runOwner = undefined;
        this.releaseLease(runId, 'run');
      },
    };
  }

  private pruneRunState(runId: RunId): void {
    const state = this.runs.get(runId);
    if (
      state &&
      state.log === undefined &&
      (state.pins?.size ?? 0) === 0 &&
      state.runOwner === undefined
    ) {
      this.runs.delete(runId);
    }
  }
  private acquireLease(
    runId: RunId,
    reason: TranscriptResidencyLeaseReason,
  ): void {
    const state = this.ensureRunState(runId);
    state.pins ??= new Set();
    state.pins.add(reason);
  }
  private releaseLease(
    runId: RunId,
    reason: TranscriptResidencyLeaseReason,
  ): void {
    const state = this.runs.get(runId);
    if (!state) return;
    this.unpin(state, reason);
    this.tryRelease(runId);
    this.pruneRunState(runId);
  }
  private unpin(state: RunState, pin: TranscriptResidencyLeaseReason): void {
    state.pins?.delete(pin);
    if (state.pins?.size === 0) state.pins = undefined;
  }
  private tryRelease(runId: RunId): void {
    const state = this.runs.get(runId);
    if (
      this.mode.kind === 'ephemeral' ||
      !state ||
      !this.releaseRequests.has(runId) ||
      (state.pins?.size ?? 0) > 0
    )
      return;
    state.log = undefined;
    state.fold = undefined;
    state.seq = undefined;
    this.pruneRunState(runId);
  }
  private ensureRunState(runId: RunId): RunState {
    let state = this.runs.get(runId);
    if (!state) {
      state = {};
      this.runs.set(runId, state);
    }
    return state;
  }
}
