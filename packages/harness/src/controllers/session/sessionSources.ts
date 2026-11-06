/**
 * The three non-durable fold inputs of a session, each a level in a `SubscriptionRef`: a snapshot read beside a
 * separately armed delta stream loses whatever lands between the two, and a
 * `SubscriptionRef` replays its current value on subscribe.
 *
 * - `LocalRuntimeSource`: what this process knows that the events cannot
 *   say: the runs a launch here holds (`runsHere`, written by the session's
 *   run registry).
 * - `TextChunkSource`: the in-flight text per streaming row, by run and
 *   row id; the ordered input reader derives suffixes from successive chunk
 *   tails after reading the events committed before them.
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
  RunId,
  TranscriptSubscription,
} from '@shared/schemas';

export class LocalRuntimeSource extends Context.Service<
  LocalRuntimeSource,
  {
    readonly ref: SubscriptionRef.SubscriptionRef<LocalRuntimeState>;
  }
>()('@texra-ai/harness/session/LocalRuntimeSource') {
  static readonly layer = Layer.effect(
    LocalRuntimeSource,
    Effect.map(
      SubscriptionRef.make<LocalRuntimeState>({ runsHere: [] }),
      (ref) => ({ ref }),
    ),
  );
}

/** An immutable append and its preceding text, shared by successive reads. */
interface InflightTextChunk {
  readonly previous: InflightTextChunk | undefined;
  readonly text: string;
  readonly length: number;
}

/** Each run's streaming rows, by row id, each at its current chunk tail. */
export type InflightText = ReadonlyMap<
  RunId,
  ReadonlyMap<string, InflightTextChunk>
>;

/** The text `chunk` holds past `tail`, from the tail's length when `chunk`
 *  extends it, else the whole chain from 0 (no tail, or a new chain). */
export function textSince(
  chunk: InflightTextChunk,
  tail?: InflightTextChunk,
): { readonly from: number; readonly text: string } {
  const parts: string[] = [];
  let at: InflightTextChunk | undefined = chunk;
  while (at !== undefined && at !== tail) {
    parts.push(at.text);
    at = at.previous;
  }
  return {
    from: at === tail ? (tail?.length ?? 0) : 0,
    text: parts.toReversed().join(''),
  };
}

export class TextChunkSource extends Context.Service<
  TextChunkSource,
  {
    readonly ref: SubscriptionRef.SubscriptionRef<InflightText>;
  }
>()('@texra-ai/harness/session/TextChunkSource') {
  static readonly layer = Layer.effect(
    TextChunkSource,
    Effect.map(SubscriptionRef.make<InflightText>(new Map()), (ref) => ({
      ref,
    })),
  );
}

export class TranscriptSubscriptions extends Context.Service<
  TranscriptSubscriptions,
  {
    /** The union of every port's set: a fold input. */
    readonly ref: SubscriptionRef.SubscriptionRef<
      readonly TranscriptSubscription[]
    >;
    /** Replace one port's set; an empty set removes the port. */
    readonly set: (
      port: string,
      set: readonly TranscriptSubscription[],
    ) => Effect.Effect<void>;
  }
>()('@texra-ai/harness/session/TranscriptSubscriptions') {
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
            // Computed under the ref's own permit, so two ports changing at
            // once cannot publish an older union after a newer one.
            return SubscriptionRef.update(ref, union);
          }),
      };
    }),
  );
}
