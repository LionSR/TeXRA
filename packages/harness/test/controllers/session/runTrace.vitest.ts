/**
 * Failure modes: two display rows of one run share a `seq` (the store
 * projects a `usage` row from a priced row, at that row's `seq`), and a
 * reader that takes a `seq` as read after its first row drops the second.
 */
// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Stream } from 'effect';
import { expect } from 'vitest';

// Local imports - harness
import { replayTrace } from '@controllers/session/runTrace';
import {
  emptyRunEndOutput,
  qualifyAggregateId,
  RunIdSchema,
  type DisplayRow,
  type SessionViewInput,
} from '@shared/schemas';

it.effect("reads the usage row projected from a model's priced title", () =>
  Effect.gen(function* () {
    const runId = RunIdSchema.make('aa0001');
    const envelope = (seq: number) => ({
      aggregateId: qualifyAggregateId('run', runId),
      seq,
      commit: seq,
      origin: null,
      at: 1_700_000_000_000 + seq,
    });
    const event = (
      read: 'aggregate' | 'all',
      row: DisplayRow,
    ): SessionViewInput => ({ _tag: 'event', read, event: row });
    const usage = { inputTokens: 12, outputTokens: 3, cost: 0.001 };
    const history: readonly SessionViewInput[] = [
      event('aggregate', { ...envelope(1), type: 'run.activate' }),
      {
        _tag: 'replay.complete',
        existence: { checkedAggregateIds: [], present: [], unreadable: [] },
      },
    ];
    // One committed batch as the store's display rows order it: the title,
    // then the `usage` row projected from it at the title's `seq`.
    const live: readonly SessionViewInput[] = [
      event('all', {
        ...envelope(2),
        type: 'run.description',
        description: 'A title',
        by: 'model',
        usage: { ...usage, responseTimeMs: 40, provider: 'openai-responses' },
      }),
      event('all', { ...envelope(2), type: 'usage', usage }),
      event('all', {
        ...envelope(3),
        type: 'run.end',
        outcome: 'completed',
        output: emptyRunEndOutput(),
      }),
    ];
    const events = yield* Stream.runCollect(
      replayTrace(
        {
          view: { inputs: () => Stream.make(history, live) },
          log: { settled: Effect.void, now: () => 3 },
        },
        runId,
        1,
        Effect.void,
      ),
    );
    expect(Array.from(events)).toStrictEqual([{ type: 'usage', usage }]);
  }),
);
