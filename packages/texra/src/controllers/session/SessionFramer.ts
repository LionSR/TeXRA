/**
 * The transport framer: one per transport port, answering each
 * `Subscribe` with the session's own ordered input reader
 * (`Session.view.watch`): a replay whole, then each tail read, each batch
 * one frame. A cold mount starts from the runtime view's cursor; a
 * resubscribe starts from the cursor it supplies. Of a tail read, the
 * transcript rows and text chunks of aggregates the subscriber did not
 * name are left out (the listing rows stay), and adjacent text chunks of
 * one row are merged, which the offsets make lossless; every frame
 * carries the commit the reader had drained, left-out rows included, so
 * the subscriber's cursor moves past them. The buffer suspends the framer
 * when the port falls behind, never the publisher. A subscriber that names
 * another set interrupts this stream and asks again.
 *
 * Rows are framed as committed: secrets never enter the event table, so no
 * framer redacts.
 */
import { Stream } from 'effect';

import { listingTypeOf } from '@texra-ai/harness/schemas';
import type {
  EventsFrame,
  Subscribe,
} from '@texra/shared/session/sessionFrames';
import type {
  CommitOrdinal,
  SessionViewInput,
} from '@texra-ai/harness/transcript';
import type { Session } from '@texra-ai/harness';

/** Frames buffered ahead of the port before the framer suspends. */
const FRAME_BUFFER = 64;

/** One batch as the subscriber takes it: the rows and chunks of aggregates
 *  it did not name left out, adjacent chunks of one row merged. */
function framed(
  named: ReadonlySet<string>,
  batch: readonly SessionViewInput[],
): SessionViewInput[] {
  const inputs: SessionViewInput[] = [];
  for (const input of batch) {
    if (
      input._tag === 'event' &&
      input.read === 'all' &&
      listingTypeOf(input.event) === null &&
      !named.has(input.event.aggregateId)
    )
      continue;
    if (input._tag === 'chunk') {
      if (!named.has(input.runId)) continue;
      const last = inputs.at(-1);
      if (
        last?._tag === 'chunk' &&
        last.runId === input.runId &&
        last.rowId === input.rowId &&
        last.to === input.from
      ) {
        inputs[inputs.length - 1] = {
          ...last,
          to: input.to,
          text: last.text + input.text,
        };
        continue;
      }
    }
    inputs.push(input);
  }
  return inputs;
}

/**
 * The frames that answer one `Subscribe`: a stream that replays, then
 * tails until interrupted. Pure over the view, so a test drives it under
 * `TestClock`.
 */
export function frameSubscription(
  view: Pick<Session['view'], 'current' | 'watch'>,
  subscribe: Subscribe,
): Stream.Stream<EventsFrame> {
  const named = new Set(subscribe.aggregates.map((entry) => entry.id));
  return Stream.suspend(() => {
    // The tail position: the session view's cursor, read before the
    // reads below, on a cold mount; the subscriber's own on a resubscribe.
    // The watch holds the subscriber's transcript set while it runs.
    const tailFrom =
      subscribe.cursor === 0 ? view.current().cursor : subscribe.cursor;
    return view
      .watch(subscribe.aggregates, {
        cursor: tailFrom,
        debug: subscribe.debug,
      })
      .pipe(
        Stream.mapAccum(
          () => tailFrom,
          (drained: CommitOrdinal, batch) => {
            const cursor =
              batch.findLast((input) => input._tag === 'drained')?.cursor ??
              drained;
            const frame: EventsFrame = {
              cursor,
              inputs: framed(named, batch),
            };
            return [cursor, [frame]] as const;
          },
        ),
        Stream.buffer({ capacity: FRAME_BUFFER, strategy: 'suspend' }),
      );
  });
}
