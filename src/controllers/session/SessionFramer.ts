/**
 * The transport framer (PRD one-fold-three-renderers, 7.4 and 8.1): one per
 * transport port, answering each Subscribe with the same ordered input
 * reader the runtime fold uses: listing, named histories, local state,
 * completion marker, then durable events before live text. Host snapshots
 * are merged beside those inputs. A cold mount starts from the runtime
 * view's cursor; a resubscribe starts from the cursor it supplies.
 * Rows are tagged with their read, transcript rows and text chunks of
 * aggregates the subscriber did not name are left out of the tail, and every frame
 * carries the commit the framer had drained when it cut it, left-out rows
 * included, so the subscriber's cursor moves past them.
 *
 * Frames contain at most 256 inputs and target 256 KiB, while a single
 * retained row can use the independent 16 MiB envelope. SessionBridge waits
 * for receiver progress after each frame; there is no queued frame buffer.
 * This suspends only this reader, never the durable publisher. Superseding
 * a generation interrupts its read and clears its transcript interests.
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
import {
  Effect,
  Schedule,
  Sink,
  Stream,
  SubscriptionRef,
  type Context,
} from 'effect';

import {
  aggregateId as qualifyAggregateId,
  type CommitOrdinal,
  type FoldInput,
  type LocalRuntimeState,
  type TextChunk,
  type TranscriptSubscription,
} from '@shared/schemas';
import type { SessionInputs } from '@shared/session/sessionInputs';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import {
  SESSION_FRAME_BYTES,
  SESSION_FRAME_ROWS,
  SESSION_FRAME_TARGET_BYTES,
  SESSION_REPLAY_BYTES,
  SESSION_REPLAY_ROWS,
  SessionReaderError,
  sessionMessageBytes,
} from '@shared/session/sessionReadBudget';
import type {
  EventsFrame,
  FoldEvent,
  Subscribe,
} from '@shared/session/sessionFrames';
import type { SessionView } from '@shared/session/sessionView';

/** The framing window: the 16 ms cadence of the old delta batches. */
const FRAME_WINDOW = '16 millis';

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
  sequence: number,
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
        if (!named.has(qualifyAggregateId('stream', item.streamId))) continue;
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
    sequence,
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
        .inputs(subscribe.aggregates, tailFrom, {
          bytes: SESSION_REPLAY_BYTES,
          rows: SESSION_REPLAY_ROWS,
        })
        .pipe(
          Stream.flatMap((batch) =>
            Stream.fromIterable(batch, { chunkSize: 1 }).pipe(
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
        Stream.aggregateWithin(
          Sink.fold(
            () => ({
              items: [] as FrameItem[],
              bytes: 0,
              next: null as FrameItem | null,
            }),
            (batch) =>
              batch.next === null &&
              batch.items.length < SESSION_FRAME_ROWS &&
              batch.bytes < SESSION_FRAME_TARGET_BYTES,
            (batch, item: FrameItem) =>
              Effect.sync(() => {
                const size = sessionMessageBytes(item);
                if (size > SESSION_FRAME_BYTES - SESSION_FRAME_TARGET_BYTES)
                  throw new SessionReaderError(
                    'A conversation update exceeds the display delivery limit. Its saved content is unchanged.',
                  );
                if (
                  batch.items.length > 0 &&
                  batch.bytes + size > SESSION_FRAME_TARGET_BYTES
                ) {
                  batch.next = item;
                  return batch;
                }
                batch.items.push(item);
                batch.bytes += size;
                return batch;
              }),
          ).pipe(
            Sink.mapEnd(
              ([batch, leftovers]) =>
                [
                  { items: batch.items },
                  // fold consumed the prospective row; return it as the first
                  // leftover so the next frame receives it exactly once.
                  batch.next === null
                    ? leftovers
                    : [batch.next, ...(leftovers ?? [])],
                ] as const,
            ),
          ),
          Schedule.spaced(FRAME_WINDOW),
        ),
        Stream.filter((batch) => batch.items.length > 0),
        Stream.mapAccum(
          () => ({ cursor: tailFrom, sequence: 0 }),
          (previous, batch) => {
            const frame = cutFrame(
              source.key,
              subscribe,
              previous.sequence + 1,
              named,
              previous.cursor,
              batch.items,
            );
            if (sessionMessageBytes(frame) > SESSION_FRAME_BYTES) {
              throw new SessionReaderError(
                'A conversation update exceeds the display delivery limit. Its saved content is unchanged.',
              );
            }
            return [
              { cursor: frame.cursor, sequence: frame.sequence },
              [frame],
            ] as const;
          },
        ),
      );
    }),
  );
}
