// Failure mode: a whole replay batch crossing the wire as one frame. A
// transcript of a few hundred tool results is one NDJSON line of tens of
// megabytes, which takes longer to arrive than the transport's liveness
// window counts as silence, so the client drops a healthy connection,
// reconnects, asks for the replay again and drops it again.

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Stream } from 'effect';
import { expect } from 'vitest';

// Local imports
import type { SessionView } from '@texra-ai/worldline/schemas';
import type { SessionViewInput } from '@texra-ai/worldline/transcript';
import { frameSubscription } from '@texra/controllers/session/SessionFramer';

const existence = { checkedAggregateIds: [], present: [], unreadable: [] };

const view = (cursor: number): SessionView => ({
  key: 'session',
  runs: new Map(),
  order: [],
  cursor,
  debug: false,
  transcriptSeq: new Map(),
  rollup: { running: 0, waiting: 0, interrupted: 0 },
  requests: [],
});

it.effect(
  'each input of a replay batch crosses the wire as its own frame',
  () =>
    Effect.gen(function* () {
      const batch: SessionViewInput[] = [
        { _tag: 'debug', enabled: false },
        { _tag: 'local', local: { runsHere: [] } },
        { _tag: 'drained', cursor: 7, existence },
      ];
      const chunks = yield* frameSubscription(
        { current: () => view(3), watch: () => Stream.make(batch) },
        { debug: false, cursor: 0, aggregates: [] },
      ).pipe(Stream.chunks, Stream.runCollect);
      // The transport writes a chunk as one message: one frame of one input.
      expect(chunks.map((chunk) => chunk.map((frame) => frame.inputs))).toEqual(
        batch.map((input) => [[input]]),
      );
      const frames = chunks.flat();
      // A frame before the drain marker carries the cursor the reader stood
      // at; the marker's frame and the ones after carry the drained commit.
      expect(frames.map((frame) => frame.cursor)).toEqual([3, 3, 7]);
    }),
);
