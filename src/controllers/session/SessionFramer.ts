/**
 * The transport framer (PRD one-fold-three-renderers, 7.4 and 8.1): one per
 * transport port, answering each `Subscribe` the port sends with the frames
 * of 8.1. Every `Subscribe` is answered the same way: the port's transcript
 * set is replaced by the one it names, then `listing()`, then
 * `aggregate(id, fromSeq)` per named aggregate in turn, then the
 * `replayComplete` marker, then `all(cursor)`, with the local and host
 * levels merged in from their current value on, where
 * the cursor is the runtime view's own cursor read before those reads on a
 * cold mount (cursor 0) and the `Subscribe`'s cursor on a resubscribe.
 * Rows are tagged with their read, transcript rows of aggregates the
 * subscriber did not name are left out of the tail, and every frame
 * carries the commit the framer had drained when it cut it, left-out rows
 * included, so the subscriber's cursor moves past them.
 *
 * Framing is `Stream.groupedWithin(rows, 16 millis)` then
 * `Stream.buffer({ strategy: 'suspend' })`: durable rows must not drop, and
 * suspension parks the framer, never the publisher. Text chunks ride the
 * same buffer, merged to one per streaming row per frame where adjacent,
 * which the offsets make lossless. A later `Subscribe` on the port
 * supersedes the replay in flight; its frames echo its generation and the
 * decoder drops the superseded one's; `SessionBridge` owns the fiber per
 * port and forks the next `Subscribe`'s stream after interrupting it.
 *
 * Display redaction (contract C3): every framer to a renderer process
 * applies display redaction and truncation. The rows this plane carries
 * today are listing facts, approval payloads scrubbed at publish
 * (`redactedForFact`), and `transcript.entry` rows the transcript recorder
 * scrubbed at record time; the byte-exact flow rows of the execution
 * aggregate arrive with the persistence cutover, and that cutover lands the
 * redaction map here, in `cutFrame`, as the obligation it makes
 * load-bearing. Nothing is framed that is not already display-safe.
 */
import { Effect, Stream, SubscriptionRef } from 'effect';

import type {
  CommitOrdinal,
  LocalRuntimeState,
  SessionEvent,
  TextChunk,
  TranscriptSubscription,
} from '@shared/schemas';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type {
  EventsFrame,
  FoldEvent,
  Subscribe,
} from '@shared/session/sessionFrames';
import type { SessionView } from '@shared/session/sessionView';

/** Rows per frame before the window cuts it. */
const FRAME_ROWS = 256;
/** The framing window: the 16 ms cadence of the old delta batches. */
const FRAME_WINDOW = '16 millis';
/** Frames buffered ahead of the port before the framer suspends. */
const FRAME_BUFFER = 64;

/** What a framer reads of its session: the view level, the plane's reads,
 *  the local snapshot level, the chunk deltas, and the port's subscription
 *  set. A `SessionHandle` has every one of these. */
export interface FramerSource {
  /** The session key on every frame. */
  readonly key: string;
  readonly view: SubscriptionRef.SubscriptionRef<SessionView>;
  readonly events: Pick<SessionEventsShape, 'listing' | 'all' | 'aggregate'>;
  readonly local: SubscriptionRef.SubscriptionRef<LocalRuntimeState>;
  readonly chunks: Stream.Stream<TextChunk>;
  readonly setTranscriptSubscriptions: (
    port: string,
    set: readonly TranscriptSubscription[],
  ) => Effect.Effect<void>;
}

type FrameItem =
  | FoldEvent
  | TextChunk
  | { readonly _tag: 'local'; readonly local: LocalRuntimeState }
  | { readonly _tag: 'host'; readonly host: HostSnapshot }
  | { readonly _tag: 'replay.complete' };

const tagged =
  (read: FoldEvent['read']) =>
  (stream: Stream.Stream<SessionEvent>): Stream.Stream<FrameItem> =>
    Stream.map(stream, (event): FrameItem => ({ _tag: 'event', read, event }));

/** One frame from the items of one window: chunks merged per row where
 *  adjacent, the last local and host snapshots, the marker, and the drained
 *  commit advanced by every tail row, framed or left out. */
function cutFrame(
  key: string,
  subscribe: Subscribe,
  named: ReadonlySet<string>,
  drainedBefore: CommitOrdinal,
  items: readonly FrameItem[],
): EventsFrame {
  const events: FoldEvent[] = [];
  const chunks = new Map<string, TextChunk>();
  let local: LocalRuntimeState | null = null;
  let host: HostSnapshot | null = null;
  let replayComplete = false;
  let drained = drainedBefore;
  for (const item of items) {
    switch (item._tag) {
      case 'event': {
        const { event } = item;
        if (item.read === 'all') {
          drained = Math.max(drained, event.commit);
          if (
            event.type === 'transcript.entry' &&
            !named.has(event.aggregateId)
          ) {
            continue;
          }
        }
        events.push(item);
        break;
      }
      case 'chunk': {
        const rowKey = `${item.streamId}/${item.rowId}`;
        const held = chunks.get(rowKey);
        chunks.set(
          rowKey,
          held && held.to === item.from
            ? { ...held, to: item.to, text: held.text + item.text }
            : item,
        );
        break;
      }
      case 'local':
        local = item.local;
        break;
      case 'host':
        host = item.host;
        break;
      case 'replay.complete':
        replayComplete = true;
        break;
    }
  }
  return {
    kind: 'events',
    session: key,
    generation: subscribe.generation,
    cursor: drained,
    events,
    chunks: [...chunks.values()],
    local,
    host,
    replayComplete,
  };
}

/**
 * The frames that answer one `Subscribe` (7.4): a stream that replays, marks,
 * then tails until interrupted. Pure over its sources, so a test drives it
 * under `TestClock`.
 */
export function frameSubscription(
  source: FramerSource,
  port: string,
  host: SubscriptionRef.SubscriptionRef<HostSnapshot | null>,
  subscribe: Subscribe,
): Stream.Stream<EventsFrame> {
  const named = new Set(subscribe.aggregates.map((s) => s.id));
  return Stream.unwrap(
    Effect.gen(function* () {
      yield* source.setTranscriptSubscriptions(port, subscribe.aggregates);
      // The tail position: the runtime view's cursor, read before the
      // reads below, on a cold mount; the subscriber's own on a resubscribe.
      const tailFrom =
        subscribe.cursor === 0
          ? (yield* SubscriptionRef.get(source.view)).cursor
          : subscribe.cursor;
      const localItem = (local: LocalRuntimeState): FrameItem => ({
        _tag: 'local',
        local,
      });
      const hostItem = (value: HostSnapshot | null): FrameItem | null =>
        value === null ? null : { _tag: 'host', host: value };
      const histories = subscribe.aggregates.reduce(
        (history, s) =>
          Stream.concat(
            history,
            source.events.aggregate(s.id, s.fromSeq).pipe(tagged('aggregate')),
          ),
        source.events.listing().pipe(tagged('listing')),
      );
      const reads = Stream.concat(
        histories,
        Stream.concat(
          Stream.make<[FrameItem]>({ _tag: 'replay.complete' }),
          source.events.all(tailFrom).pipe(tagged('all')),
        ),
      );
      // The two levels, each replaying its current value on subscribe, so
      // the snapshots ride the first window with the history.
      const levels = Stream.merge(
        SubscriptionRef.changes(source.local).pipe(Stream.map(localItem)),
        SubscriptionRef.changes(host).pipe(
          Stream.map(hostItem),
          Stream.filter((value): value is FrameItem => value !== null),
        ),
      );
      const text = source.chunks.pipe(Stream.map((chunk): FrameItem => chunk));
      return Stream.mergeAll([reads, levels, text], { concurrency: 3 }).pipe(
        Stream.groupedWithin(FRAME_ROWS, FRAME_WINDOW),
        Stream.buffer({ capacity: FRAME_BUFFER, strategy: 'suspend' }),
        Stream.mapAccum(
          () => tailFrom,
          (drained, items: readonly FrameItem[]) => {
            const frame = cutFrame(
              source.key,
              subscribe,
              named,
              drained,
              items,
            );
            return [frame.cursor, [frame]] as const;
          },
        ),
      );
    }),
  );
}
