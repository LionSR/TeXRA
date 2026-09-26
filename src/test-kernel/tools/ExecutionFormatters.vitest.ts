// Third-party imports
import * as assert from 'node:assert';
import { afterEach, beforeEach, describe, vi, type MockInstance } from 'vitest';
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
import { DatabaseReadFailed } from '@shared/session/database';
import { closeSessionOf } from '@test/support/sessionEnd';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';

const RUN_ID = RunIdSchema.parse('ec1000000001');

// Local imports
import { formatConversation } from '@tools/executions/conversationFormat';
import { resolveRunLiveness } from '@tools/executions/runLiveness';
import { turnAttributionNote } from '@tools/executions/turnAttribution';

let session: SessionHandle;
/** The claim read the status ladder asks; stubbed per case. */
let claimOwner: MockInstance<SessionHandle['claimOwner']>;
beforeEach(() => {
  session = createTestSession();
  claimOwner = vi.spyOn(session, 'claimOwner');
});

/** A foreign owner's recorded identity, as the database stores it. */
function foreignOwner(pid: number): string {
  return JSON.stringify(['other-host', pid, 'start-1']);
}

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
  session.publish([
    {
      type: 'run.end',
      aggregateId: aggregateId('run', RUN_ID),
      outcome,
      output: emptyRunEndOutput('toolUse'),
    },
  ]);
  await vi.waitFor(() => {
    assert.strictEqual(session.runView(RUN_ID)?.status, outcome);
  });
}

describe('resolveRunLiveness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Unclaimed unless a case says otherwise: the claim is the only thing an
    // outcome-less row has left to ask.
    claimOwner.mockReturnValue(
      Effect.succeed({ ownerId: null, liveness: null }),
    );
  });

  it.effect('calls a run nobody owns and nothing recorded interrupted', () =>
    Effect.gen(function* () {
      claimOwner.mockReturnValue(
        Effect.succeed({ ownerId: null, liveness: null }),
      );

      const liveness = yield* onSessionRuns(
        resolveRunLiveness(RUN_ID, session),
      );

      // The two facts the arm was decided from, and nothing about whether
      // there is anything left to continue.
      assert.deepStrictEqual(liveness, { kind: 'interrupted' });
    }),
  );

  it.effect('does not settle a run while another process holds it', () =>
    Effect.gen(function* () {
      claimOwner.mockReturnValue(
        Effect.succeed({ ownerId: foreignOwner(4242), liveness: 'alive' }),
      );

      const liveness = yield* onSessionRuns(
        resolveRunLiveness(RUN_ID, session),
      );

      assert.strictEqual(liveness.kind, 'unsettled');
      assert.match(
        liveness.kind === 'unsettled' ? liveness.reason : '',
        /pid 4242 on other-host/,
      );
    }),
  );

  it.effect(
    'does not settle a run whose claim this process holds with no run',
    () =>
      Effect.gen(function* () {
        claimOwner.mockReturnValue(
          Effect.succeed({
            ownerId: foreignOwner(process.pid),
            liveness: 'self',
          }),
        );

        const liveness = yield* onSessionRuns(
          resolveRunLiveness(RUN_ID, session),
        );

        assert.strictEqual(liveness.kind, 'unsettled');
        assert.match(
          liveness.kind === 'unsettled' ? liveness.reason : '',
          /no live run/,
        );
      }),
  );

  it.effect('reports an unreadable claim rather than a terminal reading', () =>
    Effect.gen(function* () {
      claimOwner.mockReturnValue(
        Effect.fail(
          new DatabaseReadFailed({
            path: 'session.db',
            cause: new Error('claim unreadable'),
          }),
        ),
      );

      const liveness = yield* onSessionRuns(
        resolveRunLiveness(RUN_ID, session),
      );

      assert.strictEqual(liveness.kind, 'unsettled');
      assert.match(
        liveness.kind === 'unsettled' ? liveness.reason : '',
        /cannot read \(claim unreadable\)/,
      );
    }),
  );
});

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
        yield* session.commit([
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
