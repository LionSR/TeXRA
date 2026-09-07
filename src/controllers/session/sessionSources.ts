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
 *   `${streamId}/${rowId}`; the ordered input reader derives suffixes from
 *   successive chunk tails after reading the events committed before them.
 * - `TranscriptSubscriptions`: the aggregates some surface holds a
 *   transcript subscription on, the union of one set per port.
 *
 * The runtime input reader captures these levels before its finite event
 * read. A webview receives the resulting ordered inputs directly, without
 * constructing another copy of the accumulated text.
 */
import { Context, Effect, Layer, SubscriptionRef } from 'effect';

import type {
  AggregateId,
  LocalRuntimeState,
  TranscriptSubscription,
} from '@shared/schemas';
import { ProcessIdentity } from '@shared/session/sessionEvents';

export class LocalRuntimeSource extends Context.Service<
  LocalRuntimeSource,
  {
    readonly ref: SubscriptionRef.SubscriptionRef<LocalRuntimeState>;
  }
>()('@texra/session/LocalRuntimeSource') {
  static readonly layer = Layer.effect(
    LocalRuntimeSource,
    Effect.gen(function* () {
      const identity = yield* ProcessIdentity;
      const ref = yield* SubscriptionRef.make<LocalRuntimeState>({
        self: [identity.ownerId],
        dead: [],
        unreadable: [],
      });
      return { ref };
    }),
  );
}

/** An immutable append and its preceding text, shared by successive reads. */
export interface InflightTextChunk {
  readonly previous: InflightTextChunk | undefined;
  readonly text: string;
  readonly length: number;
}

/** The `${streamId}/${rowId}` key of one streaming row's current chunk tail. */
export type InflightText = ReadonlyMap<string, InflightTextChunk>;

export class TextChunkSource extends Context.Service<
  TextChunkSource,
  {
    readonly ref: SubscriptionRef.SubscriptionRef<InflightText>;
  }
>()('@texra/session/TextChunkSource') {
  static readonly layer = Layer.effect(
    TextChunkSource,
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<InflightText>(new Map());
      return { ref };
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
        const byId = new Map<AggregateId, TranscriptSubscription>();
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
