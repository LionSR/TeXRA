// Third-party imports
import * as assert from 'node:assert';
import { afterEach, beforeEach, describe, vi } from 'vitest';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { Runs } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  emptyRunEndOutput,
  RunIdSchema,
  type RunOutcome,
  type SessionEventDraft,
} from '@shared/schemas';
import { closeSessionOf } from '@test/support/sessionEnd';
import {
  createTestSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';

const RUN_ID = RunIdSchema.parse('ec1000000001');

// Local imports
import { formatConversation } from '@tools/executions/conversationFormat';
import { turnAttributionNote } from '@tools/executions/turnAttribution';

let session: SessionHandle;
beforeEach(async () => {
  session = await Effect.runPromise(createTestSession());
});

/** Run a status read on the suite session's runs. */
function onSessionRuns<A, E>(
  effect: Effect.Effect<A, E, Runs>,
): Effect.Effect<A, E> {
  return effect.pipe(Effect.provideService(Runs, session.runs));
}
afterEach(async () => {
  await Effect.runPromise(closeSessionOf(session));
});

/**
 * End the run for real: `run.end` is the terminal fact the fold reads a
 * terminal phase from, so a tracked handle reports it the way the registry
 * does in production.
 */
async function endRun(outcome: RunOutcome): Promise<void> {
  publishTestRunStart(session, RUN_ID);
  publishTestRows(session, [
    {
      type: 'run.end',
      aggregateId: aggregateId('run', RUN_ID),
      outcome,
      output: emptyRunEndOutput(),
    },
  ]);
  await vi.waitFor(() => {
    assert.strictEqual(session.view.run(RUN_ID)?.status, outcome);
  });
}

describe('turnAttributionNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.live(
    'does not call an accepted turn running once its run is terminal',
    () =>
      Effect.gen(function* () {
        // The handle outlives the run's terminal phase, so handle presence
        // alone must not word the note as "still running".
        const handle = testRunHandle({ runId: RUN_ID, agent: 'test' });
        session.runs.track(handle);
        yield* Effect.promise(() => endRun('completed'));
        // The turn identity is structural now: one settled turn behind the
        // accepted one the note has to word.
        const turnRow = (
          turnIndex: number,
          phase: 'accepted' | 'settled',
        ): SessionEventDraft => ({
          type: 'child.turn',
          aggregateId: aggregateId('run', RUN_ID),
          attemptId: 'attempt-1',
          turnIndex,
          phase,
        });
        yield* session.log.transact([
          turnRow(1, 'accepted'),
          turnRow(1, 'settled'),
          turnRow(2, 'accepted'),
        ]);

        const note = yield* onSessionRuns(turnAttributionNote(RUN_ID, session));

        assert.match(
          note ?? '',
          /turn 2 of attempt attempt-1 was interrupted: it ended with its run \(completed\)/,
        );
        assert.match(note ?? '', /turn 1 of attempt attempt-1/);
        assert.doesNotMatch(note ?? '', /still running/);
      }),
  );
});

describe('formatConversation', () => {
  // The executions conversation view stays pure ASCII: a long message is cut
  // with `...`, never the Unicode ellipsis the shared truncation helper uses.
  it('truncates long conversation text with an ASCII ellipsis', () => {
    const output = formatConversation([
      { kind: 'assistant-text', text: 'x'.repeat(501) },
    ]);

    assert.ok(output.includes(`${'x'.repeat(497)}...`));
    assert.ok(!output.includes('…'));
  });
});
