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
import { StreamLog, type StreamLogDelta } from '@shared/session/traceEntries';
import { createTranscriptFold } from '@shared/session/traceFold';
import { createListenerSet } from '@utils/core/listenerSet';

type TranscriptDatabase = Pick<
  Context.Service.Shape<typeof Database>,
  'readAggregate' | 'readListing'
>;
type StreamLogListener = (streamId: RunId, delta: StreamLogDelta) => void;
export type StreamLogStoreMode =
  | { readonly kind: 'persistent' }
  | { readonly kind: 'ephemeral'; readonly reason: string };

interface StreamRunOwnership {
  readonly ownerKey: string;
  readonly tokens: Set<symbol>;
}
type TranscriptResidencyLeaseReason = 'run' | 'focus';
export interface TranscriptResidencyLease {
  readonly streamId: RunId;
  close(): void;
}
interface StreamState {
  log?: StreamLog;
  fold?: ReturnType<typeof createTranscriptFold>;
  seq?: number;
  pins?: Set<TranscriptResidencyLeaseReason | symbol>;
  runOwner?: StreamRunOwnership;
}

/** Apply one event with the same projection used by the live recorder. */
function applyEvent(
  log: StreamLog,
  fold: ReturnType<typeof createTranscriptFold>,
  event: SessionEvent,
): void {
  if (event.type === 'transcript.entry') log.record(event.entry);
  else if (event.type === 'status') fold.status(event.phase);
  else if (isTranscriptEvent(event))
    fold.record(event, {
      at: event.at,
      id: JSON.stringify([event.aggregateId, event.seq]),
      debug: event.transcriptDebug ?? false,
    });
}

function foldEntries(events: readonly SessionEvent[]): StreamState | undefined {
  if (events.length === 0 || events.at(-1)?.type === 'stream.removed') return;
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
  private readonly streams = new Map<RunId, StreamState>();
  private readonly known = new Set<RunId>();
  private readonly releaseRequests = new Set<RunId>();
  private readonly listeners = createListenerSet<StreamLogListener>();
  private readonly gate = Semaphore.makeUnsafe(1);

  private constructor(
    readonly mode: StreamLogStoreMode,
    private readonly database?: TranscriptDatabase,
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
        else if (event.type === 'stream.removed') store.known.delete(id);
      }
      return store;
    });
  }

  /** Explicitly memory-only transcripts for ephemeral session roots. */
  static ephemeral(reason: string): StreamLogStore {
    const normalized = reason.trim();
    if (!normalized)
      throw new Error('An ephemeral transcript store requires a reason.');
    return new StreamLogStore({ kind: 'ephemeral', reason: normalized });
  }

  onChange(listener: StreamLogListener): () => void {
    return this.listeners.add(listener);
  }
  get(streamId: RunId): StreamLog | undefined {
    return this.streams.get(streamId)?.log;
  }
  has(streamId: RunId): boolean {
    return this.known.has(streamId);
  }

  /** Read a complete event prefix without changing residency. */
  readEntries(streamId: RunId) {
    return this.database === undefined
      ? Effect.sync(() => this.get(streamId)?.toJSON() ?? [])
      : this.database
          .readAggregate(aggregateId('run', streamId), 0)
          .pipe(
            Effect.map((events) => foldEntries(events)?.log?.toJSON() ?? []),
          );
  }

  hasAuthoritativeStream(streamId: RunId) {
    return this.database === undefined
      ? Effect.sync(() => this.has(streamId))
      : this.database
          .readAggregate(aggregateId('run', streamId), 0)
          .pipe(
            Effect.map(
              (events) =>
                events.length > 0 && events.at(-1)?.type !== 'stream.removed',
            ),
          );
  }

  ensureStream(streamId: RunId): void {
    if (this.known.has(streamId)) return;
    this.known.add(streamId);
    this.ensureStreamState(streamId).log = new StreamLog();
  }

  requestEviction(streamId: RunId): void {
    if (this.mode.kind === 'ephemeral') return;
    this.releaseRequests.add(streamId);
    const state = this.streams.get(streamId);
    if (state) this.unpin(state, 'focus');
    this.tryRelease(streamId);
  }

  /** Retain a run's transcript for the run itself: the run is its own owner key. */
  acquireRunResidency(streamId: RunId) {
    return this.gate.withPermit(
      Effect.gen({ self: this }, function* () {
        const residency = this.retainRun(streamId, streamId);
        yield* this.loadEntries(streamId).pipe(
          Effect.onError(() => Effect.sync(() => residency.close())),
        );
        return residency;
      }),
    );
  }

  ensureLoaded(
    streamId: RunId,
    options: { retainForPresentation: true },
  ): Effect.Effect<TranscriptResidencyLease, Error>;
  ensureLoaded(streamId: RunId): Effect.Effect<void, Error>;
  ensureLoaded(
    streamId: RunId,
    options?: { retainForPresentation: true },
  ): Effect.Effect<void | TranscriptResidencyLease, Error> {
    return Effect.gen({ self: this }, function* () {
      if (!options?.retainForPresentation) {
        this.acquireLease(streamId, 'focus');
        this.releaseRequests.delete(streamId);
        yield* this.gate.withPermit(this.loadEntries(streamId));
        return;
      }
      const token = Symbol(streamId);
      const state = this.ensureStreamState(streamId);
      state.pins ??= new Set();
      state.pins.add(token);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        const current = this.streams.get(streamId);
        if (current) this.unpin(current, token);
        this.requestEviction(streamId);
        this.pruneStreamState(streamId);
      };
      yield* this.gate
        .withPermit(this.loadEntries(streamId))
        .pipe(Effect.onError(() => Effect.sync(close)));
      return { streamId, close };
    });
  }

  private loadEntries(streamId: RunId) {
    return Effect.gen({ self: this }, function* () {
      if (this.get(streamId) !== undefined || this.database === undefined)
        return;
      const entries = foldEntries(
        yield* this.database.readAggregate(aggregateId('run', streamId), 0),
      );
      if (entries === undefined) {
        this.known.delete(streamId);
        return;
      }
      this.known.add(streamId);
      Object.assign(this.ensureStreamState(streamId), entries);
      this.notify(streamId, true);
    });
  }

  /** Apply the ordered committed tail under the same permit as cold hydration. */
  acceptCommitted(event: SessionEvent) {
    return this.gate.withPermit(
      Effect.sync(() => {
        const target = aggregateTarget(event.aggregateId);
        if (target.kind !== 'run') return;
        const streamId = target.id;
        if (event.type === 'run.start') this.known.add(streamId);
        if (event.type === 'stream.removed') {
          this.streams.delete(streamId);
          this.known.delete(streamId);
          this.releaseRequests.delete(streamId);
          return;
        }
        const state = this.streams.get(streamId);
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
        this.notify(streamId);
      }),
    );
  }

  /** Forget only the resident projection after committed deletion. */
  delete(streamId: RunId) {
    return this.gate.withPermit(
      Effect.sync(() => {
        this.streams.delete(streamId);
        this.known.delete(streamId);
        this.releaseRequests.delete(streamId);
      }),
    );
  }

  clear() {
    return this.gate.withPermit(
      Effect.sync(() => {
        this.streams.clear();
        this.known.clear();
        this.releaseRequests.clear();
      }),
    );
  }

  private retainRun(
    streamId: RunId,
    ownerKey: string,
  ): TranscriptResidencyLease {
    if (!ownerKey.trim()) {
      throw new Error(
        'Transcript run residency requires a non-empty owner key.',
      );
    }

    const current = this.streams.get(streamId)?.runOwner;
    if (current && current.ownerKey !== ownerKey) {
      throw new Error(
        `Transcript stream ${streamId} is already owned by another run.`,
      );
    }
    const ownership =
      current ?? ({ ownerKey, tokens: new Set() } satisfies StreamRunOwnership);
    const token = Symbol(ownerKey);
    ownership.tokens.add(token);
    const runState = this.ensureStreamState(streamId);
    runState.runOwner = ownership;
    this.acquireLease(streamId, 'run');
    let closed = false;

    return {
      streamId,
      close: () => {
        if (closed) return;
        closed = true;
        const state = this.streams.get(streamId);
        if (!state || state.runOwner !== ownership) return;
        ownership.tokens.delete(token);
        if (ownership.tokens.size > 0) return;
        state.runOwner = undefined;
        this.releaseLease(streamId, 'run');
      },
    };
  }

  private pruneStreamState(streamId: RunId): void {
    const state = this.streams.get(streamId);
    if (
      state &&
      state.log === undefined &&
      (state.pins?.size ?? 0) === 0 &&
      state.runOwner === undefined
    ) {
      this.streams.delete(streamId);
    }
  }
  private acquireLease(
    streamId: RunId,
    reason: TranscriptResidencyLeaseReason,
  ): void {
    const state = this.ensureStreamState(streamId);
    state.pins ??= new Set();
    state.pins.add(reason);
  }
  private releaseLease(
    streamId: RunId,
    reason: TranscriptResidencyLeaseReason,
  ): void {
    const state = this.streams.get(streamId);
    if (!state) return;
    this.unpin(state, reason);
    this.tryRelease(streamId);
    this.pruneStreamState(streamId);
  }
  private unpin(
    state: StreamState,
    pin: TranscriptResidencyLeaseReason | symbol,
  ): void {
    state.pins?.delete(pin);
    if (state.pins?.size === 0) state.pins = undefined;
  }
  private tryRelease(streamId: RunId): void {
    const state = this.streams.get(streamId);
    if (
      this.mode.kind === 'ephemeral' ||
      !state ||
      !this.releaseRequests.has(streamId) ||
      (state.pins?.size ?? 0) > 0
    )
      return;
    state.log = undefined;
    state.fold = undefined;
    state.seq = undefined;
    this.pruneStreamState(streamId);
  }
  private ensureStreamState(streamId: RunId): StreamState {
    let state = this.streams.get(streamId);
    if (!state) {
      state = {};
      this.streams.set(streamId, state);
    }
    return state;
  }

  private notify(streamId: RunId, reset = false): void {
    const log = this.get(streamId);
    if (log === undefined) return;
    const delta = { ...log.drainEmission(), reset };
    for (const listener of this.listeners) listener(streamId, delta);
  }
}
