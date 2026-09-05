/**
 * The transport framer (PRD one-fold-three-renderers, 7.4 and 8.1): one per
 * transport port, answering each Subscribe with the same ordered input
 * reader the runtime fold uses: listing, named histories, local state,
 * completion marker, then durable events before live text. Host snapshots
 * are merged beside those inputs. A cold mount starts from the runtime
 * view's cursor; a resubscribe starts from the cursor it supplies.
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
import { Effect, Stream, SubscriptionRef, type Context } from 'effect';

import type {
  CommitOrdinal,
  FoldInput,
  LocalRuntimeState,
  TextChunk,
  TranscriptSubscription,
} from '@shared/schemas';
import type { SessionInputs } from '@shared/session/sessionInputs';
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

/** The session view, ordered input reader, and per-port subscription setter. */
export interface FramerSource {
  /** The session key on every frame. */
  readonly key: string;
  readonly view: SubscriptionRef.SubscriptionRef<SessionView>;
  readonly inputs: Context.Service.Shape<typeof SessionInputs>['read'];
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
  | { readonly _tag: 'replay.complete' }
  | { readonly _tag: 'drained'; readonly cursor: CommitOrdinal };

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
      case 'drained':
        drained = Math.max(drained, item.cursor);
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
      const inputs = source
        .inputs(subscribe.aggregates, tailFrom)
        .pipe(
          Stream.flatMap((batch) =>
            Stream.fromIterable(batch).pipe(
              Stream.filter(
                (
                  input,
                ): input is Exclude<FoldInput, { _tag: 'subscriptions' }> =>
                  input._tag !== 'subscriptions',
              ),
            ),
          ),
        );
      const hosts = SubscriptionRef.changes(host).pipe(
        Stream.filter((value): value is HostSnapshot => value !== null),
        Stream.map((value): FrameItem => ({ _tag: 'host', host: value })),
      );
      return Stream.merge(inputs, hosts).pipe(
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
