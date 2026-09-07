/** Resident transcript entries, hydrated from the session's event table. */
import { Effect, Semaphore, type Context } from 'effect';

import {
  aggregateId,
  aggregateTarget,
  isTranscriptEvent,
  type SessionEvent,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import type { Database } from '@shared/session/database';
import {
  StreamLog,
  type StreamLogAppendInput,
  type StreamLogDelta,
  type StreamLogUpdatePatch,
} from '@shared/session/traceEntries';
import { createTranscriptFold } from '@shared/session/traceFold';
import { createListenerSet } from '@utils/core/listenerSet';
import { ResidentStreamRegistry } from './ResidentStreamRegistry';

type TranscriptDatabase = Pick<
  Context.Service.Shape<typeof Database>,
  'readAggregate' | 'readListing'
>;
type StreamLogListener = (streamId: StreamTabId, delta: StreamLogDelta) => void;
export type StreamLogStoreMode =
  | { readonly kind: 'persistent' }
  | { readonly kind: 'ephemeral'; readonly reason: string };

export interface TranscriptWriter {
  readonly streamId: StreamTabId;
  append(entry: StreamLogAppendInput): StreamLogEntry;
  appendSettled(entry: StreamLogAppendInput): StreamLogEntry;
  update(id: string, patch: StreamLogUpdatePatch): StreamLogEntry | undefined;
  settle(id: string, patch: StreamLogUpdatePatch): StreamLogEntry | undefined;
  appendText(id: string, text: string): StreamLogEntry | undefined;
  close(): void;
}
interface StreamWriterOwnership {
  readonly ownerKey: string;
  readonly tokens: Set<symbol>;
}
type TranscriptResidencyLeaseReason = 'writer' | 'focus';
export interface TranscriptPresentationLease {
  readonly streamId: StreamTabId;
  close(): void;
}
interface StreamState {
  log?: StreamLog;
  fold?: ReturnType<typeof createTranscriptFold>;
  seq?: number;
  pins?: Set<TranscriptResidencyLeaseReason | symbol>;
  writer?: StreamWriterOwnership;
}

/** Every entry is derived with the same projection used by the live recorder. */
function foldEntries(events: readonly SessionEvent[]): StreamState | undefined {
  if (events.length === 0 || events.at(-1)?.type === 'stream.removed') return;
  if (events[0]?.type !== 'run.start' || events[0].seq !== 1) {
    throw new Error('A transcript read must begin with its creation row.');
  }
  const entries = new StreamLog();
  const fold = createTranscriptFold(entries);
  for (const event of events) {
    if (event.type === 'transcript.entry') entries.record(event.entry);
    else if (event.type === 'status') fold.status(event.phase);
    else if (isTranscriptEvent(event)) {
      fold.record(event, {
        at: event.at,
        id: JSON.stringify([event.aggregateId, event.seq]),
        debug: event.transcriptDebug ?? false,
      });
    }
  }
  entries.drainEmission();
  return { log: entries, fold, seq: events.at(-1)!.seq };
}

export class StreamLogStore {
  private readonly streams = new ResidentStreamRegistry<
    StreamTabId,
    StreamState
  >(() => ({}));
  private readonly known = new Set<StreamTabId>();
  private readonly releaseRequests = new Set<StreamTabId>();
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
        if (target.kind !== 'stream') continue;
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
  get(streamId: StreamTabId): StreamLog | undefined {
    return this.streams.get(streamId)?.log;
  }
  has(streamId: StreamTabId): boolean {
    return this.known.has(streamId);
  }

  /** Read a complete event prefix without changing residency. */
  readEntries(streamId: StreamTabId) {
    return this.database === undefined
      ? Effect.sync(() => this.get(streamId)?.toJSON() ?? [])
      : this.database
          .readAggregate(aggregateId('stream', streamId), 0)
          .pipe(
            Effect.map((events) => foldEntries(events)?.log?.toJSON() ?? []),
          );
  }

  hasAuthoritativeStream(streamId: StreamTabId) {
    return this.database === undefined
      ? Effect.sync(() => this.has(streamId))
      : this.database
          .readAggregate(aggregateId('stream', streamId), 0)
          .pipe(
            Effect.map(
              (events) =>
                events.length > 0 && events.at(-1)?.type !== 'stream.removed',
            ),
          );
  }

  ensureStream(streamId: StreamTabId): void {
    if (this.known.has(streamId)) return;
    this.known.add(streamId);
    this.ensureStreamState(streamId).log = new StreamLog();
  }

  requestEviction(streamId: StreamTabId): void {
    if (this.mode.kind === 'ephemeral') return;
    this.releaseRequests.add(streamId);
    const state = this.streams.get(streamId);
    if (state) this.unpin(state, 'focus');
    this.tryRelease(streamId);
  }

  acquireWriter(streamId: StreamTabId, ownerKey: string): TranscriptWriter {
    return this.createWriter(streamId, ownerKey, false);
  }

  loadAndAcquireWriter(streamId: StreamTabId, ownerKey: string) {
    return this.gate.withPermit(
      Effect.gen({ self: this }, function* () {
        const writer = this.createWriter(streamId, ownerKey, true);
        yield* this.loadEntries(streamId).pipe(
          Effect.onError(() => Effect.sync(() => writer.close())),
        );
        return writer;
      }),
    );
  }

  ensureLoaded(
    streamId: StreamTabId,
    options: { retainForPresentation: true },
  ): Effect.Effect<TranscriptPresentationLease, Error>;
  ensureLoaded(streamId: StreamTabId): Effect.Effect<void, Error>;
  ensureLoaded(
    streamId: StreamTabId,
    options?: { retainForPresentation: true },
  ): Effect.Effect<void | TranscriptPresentationLease, Error> {
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

  private loadEntries(streamId: StreamTabId) {
    return Effect.gen({ self: this }, function* () {
      if (this.get(streamId) !== undefined || this.database === undefined)
        return;
      const entries = foldEntries(
        yield* this.database.readAggregate(aggregateId('stream', streamId), 0),
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
        if (target.kind !== 'stream') return;
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
          (state.log === undefined && state.writer === undefined)
        )
          return;
        // Hydration may already include this tail row. Aggregate sequence is
        // the prefix boundary, independent of when its wake was delivered.
        if (event.seq <= (state.seq ?? 0)) return;
        state.log ??= new StreamLog();
        state.fold ??= createTranscriptFold(state.log);
        if (event.type === 'transcript.entry') state.log.record(event.entry);
        else if (event.type === 'status') state.fold.status(event.phase);
        else if (isTranscriptEvent(event))
          state.fold.record(event, {
            at: event.at,
            id: JSON.stringify([event.aggregateId, event.seq]),
            debug: event.transcriptDebug ?? false,
          });
        state.seq = event.seq;
        this.notify(streamId);
      }),
    );
  }

  /** Forget only the resident projection after committed deletion. */
  delete(streamId: StreamTabId) {
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

  private createWriter(
    streamId: StreamTabId,
    ownerKey: string,
    allowReleased: boolean,
  ): TranscriptWriter {
    if (!ownerKey.trim()) {
      throw new Error('A transcript writer requires a non-empty owner key.');
    }

    if (
      !allowReleased &&
      this.mode.kind === 'persistent' &&
      this.known.has(streamId) &&
      this.streams.get(streamId)?.log === undefined
    ) {
      throw new Error(
        `Cannot acquire a writer for released stream ${streamId}. Run ensureLoaded() first.`,
      );
    }

    const current = this.streams.get(streamId)?.writer;
    if (current && current.ownerKey !== ownerKey) {
      throw new Error(
        `Transcript stream ${streamId} is already owned by another writer.`,
      );
    }
    const ownership =
      current ??
      ({ ownerKey, tokens: new Set() } satisfies StreamWriterOwnership);
    const token = Symbol(ownerKey);
    ownership.tokens.add(token);
    const writerState = this.ensureStreamState(streamId);
    writerState.writer = ownership;
    this.acquireLease(streamId, 'writer');
    let closed = false;

    const assertOwned = (): void => {
      if (closed || this.streams.get(streamId)?.writer !== ownership) {
        throw new Error(`Transcript writer for ${streamId} has been released.`);
      }
    };

    return {
      streamId,
      append: (entry) => {
        assertOwned();
        return this.appendEntry(streamId, entry, false);
      },
      appendSettled: (entry) => {
        assertOwned();
        return this.appendEntry(streamId, entry, true);
      },
      update: (id, patch) => {
        assertOwned();
        return this.mutateEntry(streamId, (log) => log.update(id, patch));
      },
      settle: (id, patch) => {
        assertOwned();
        return this.mutateEntry(streamId, (log) => log.settle(id, patch));
      },
      appendText: (id, text) => {
        assertOwned();
        return this.mutateEntry(streamId, (log) => log.appendText(id, text));
      },
      close: () => {
        if (closed) return;
        closed = true;
        const state = this.streams.get(streamId);
        if (!state || state.writer !== ownership) return;
        ownership.tokens.delete(token);
        if (ownership.tokens.size > 0) return;
        state.writer = undefined;
        this.releaseLease(streamId, 'writer');
      },
    };
  }

  private ensureStreamState(streamId: StreamTabId): StreamState {
    return this.streams.getOrCreate(streamId);
  }
  private pruneStreamState(streamId: StreamTabId): void {
    this.streams.pruneIfEmpty(
      streamId,
      (state) =>
        state.log === undefined &&
        (state.pins?.size ?? 0) === 0 &&
        state.writer === undefined,
    );
  }
  private appendEntry(
    streamId: StreamTabId,
    entry: StreamLogAppendInput,
    settled: boolean,
  ): StreamLogEntry {
    const state = this.ensureStreamState(streamId);
    state.log ??= new StreamLog();
    this.known.add(streamId);
    const appended = settled
      ? state.log.appendSettled(entry)
      : state.log.append(entry);
    this.notify(streamId);
    return appended;
  }
  private mutateEntry(
    streamId: StreamTabId,
    apply: (log: StreamLog) => StreamLogEntry | undefined,
  ): StreamLogEntry | undefined {
    const log = this.get(streamId);
    if (log === undefined) return;
    const updated = apply(log);
    if (updated !== undefined) this.notify(streamId);
    return updated;
  }
  private acquireLease(
    streamId: StreamTabId,
    reason: TranscriptResidencyLeaseReason,
  ): void {
    const state = this.ensureStreamState(streamId);
    state.pins ??= new Set();
    state.pins.add(reason);
  }
  private releaseLease(
    streamId: StreamTabId,
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
  private tryRelease(streamId: StreamTabId): void {
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
  private notify(streamId: StreamTabId, reset = false): void {
    const log = this.get(streamId);
    if (log === undefined) return;
    const delta = { ...log.drainEmission(), reset };
    for (const listener of this.listeners) listener(streamId, delta);
  }
}
