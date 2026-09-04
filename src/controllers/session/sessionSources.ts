/**
 * The three non-durable fold inputs of a session (PRD one-fold-three-renderers,
 * 7.2), each a level in a `SubscriptionRef`: a snapshot read beside a
 * separately armed delta stream loses whatever lands between the two, and a
 * `SubscriptionRef` replays its current value on subscribe.
 *
 * - `LocalRuntimeSource`: what this process knows that the events cannot
 *   say: its own owner id, the owners whose runs it may not touch (alive or
 *   unprovable, written by the liveness prober in `sessionLayer.ts`), and
 *   the streams whose run state it could not read (written by
 *   `StreamStatusMachine` through the session).
 * - `TextChunkSource`: the in-flight text per streaming row, keyed
 *   `${streamId}/${rowId}`; `changes` derives each subscriber's chunks from
 *   the difference between consecutive values, so a fresh subscriber's first
 *   chunk per row is `from: 0` and no chunk is ever lost.
 * - `TranscriptSubscriptions`: the aggregates some surface holds a
 *   transcript subscription on, the union of one set per port.
 */
import { Context, Effect, Layer, Stream, SubscriptionRef } from 'effect';

import { ProcessIdentity } from '@agent/runtime/SessionEvents';
import type {
  LocalRuntimeState,
  TextChunk,
  TranscriptSubscription,
} from '@shared/schemas';

export class LocalRuntimeSource extends Context.Service<
  LocalRuntimeSource,
  {
    readonly ref: SubscriptionRef.SubscriptionRef<LocalRuntimeState>;
    readonly changes: Stream.Stream<LocalRuntimeState>;
  }
>()('@texra/session/LocalRuntimeSource') {
  static readonly layer = Layer.effect(
    LocalRuntimeSource,
    Effect.gen(function* () {
      const identity = yield* ProcessIdentity;
      const ref = yield* SubscriptionRef.make<LocalRuntimeState>({
        self: [identity.ownerId],
        heldBy: [],
        unreadable: [],
      });
      return { ref, changes: SubscriptionRef.changes(ref) };
    }),
  );
}

/** The `${streamId}/${rowId}` key of one streaming row's in-flight text. */
export type InflightText = ReadonlyMap<string, string>;

/** The chunks that take a subscriber from `previous` to `next`: the appended
 *  suffix when the text grew in place, the whole text from offset zero when
 *  it was replaced. Two adjacent chunks for a row merge into one exactly, so
 *  a subscriber that missed an intermediate level still ends correct. */
function chunksBetween(
  previous: InflightText,
  next: InflightText,
): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const [key, text] of next) {
    const held = previous.get(key) ?? '';
    if (text === held) continue;
    const slash = key.indexOf('/');
    const streamId = key.slice(0, slash);
    const rowId = key.slice(slash + 1);
    const from = text.startsWith(held) ? held.length : 0;
    if (text.length <= from) continue;
    chunks.push({
      _tag: 'chunk',
      streamId,
      rowId,
      from,
      to: text.length,
      text: text.slice(from),
    });
  }
  return chunks;
}

export class TextChunkSource extends Context.Service<
  TextChunkSource,
  {
    readonly ref: SubscriptionRef.SubscriptionRef<InflightText>;
    readonly changes: Stream.Stream<TextChunk>;
  }
>()('@texra/session/TextChunkSource') {
  static readonly layer = Layer.effect(
    TextChunkSource,
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<InflightText>(new Map());
      const changes = SubscriptionRef.changes(ref).pipe(
        Stream.mapAccum(
          (): InflightText => new Map(),
          (previous, next) => [next, chunksBetween(previous, next)] as const,
        ),
      );
      return { ref, changes };
    }),
  );
}

export class TranscriptSubscriptions extends Context.Service<
  TranscriptSubscriptions,
  {
    /** The union of every port's set: a fold input (PRD 7.2). */
    readonly ref: SubscriptionRef.SubscriptionRef<
      readonly TranscriptSubscription[]
    >;
    /** Replace one port's set; an empty set removes the port. */
    readonly set: (
      port: string,
      set: readonly TranscriptSubscription[],
    ) => Effect.Effect<void>;
  }
>()('@texra/session/TranscriptSubscriptions') {
  static readonly layer = Layer.effect(
    TranscriptSubscriptions,
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<
        readonly TranscriptSubscription[]
      >([]);
      const ports = new Map<string, readonly TranscriptSubscription[]>();
      const union = (): TranscriptSubscription[] => {
        // The lowest `fromSeq` any port asks for: a port that already holds
        // an aggregate's history must not shorten another's read.
        const byId = new Map<string, TranscriptSubscription>();
        for (const set of ports.values()) {
          for (const entry of set) {
            const held = byId.get(entry.id);
            if (!held || entry.fromSeq < held.fromSeq)
              byId.set(entry.id, entry);
          }
        }
        return [...byId.values()];
      };
      return {
        ref,
        set: (port, set) =>
          Effect.suspend(() => {
            if (set.length === 0) ports.delete(port);
            else ports.set(port, set);
            return SubscriptionRef.set(ref, union());
          }),
      };
    }),
  );
}
