// Third-party imports
import * as assert from 'node:assert';
import {
  beforeEach,
  afterEach,
  describe,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { Effect } from 'effect';
import { Runs } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  emptyRunEndOutput,
  RunIdSchema,
  type RunEnd,
  type RunOutcome,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';

const RUN_ID = RunIdSchema.parse('ec1000000001');

const mocks = vi.hoisted(() => ({
  readRunEnd: vi.fn(),
}));

vi.mock('@agent/storage/runRecords', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/runRecords')>()),
  getRunRecords: () => ({ readRunEnd: mocks.readRunEnd }),
}));

// Local imports
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
function onSessionRuns<A, E>(effect: Effect.Effect<A, E, Runs>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provideService(Runs, session.runs)),
  );
}
afterEach(async () => {
  await Effect.runPromise(session.dispose());
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

/** The one persisted fact the ladder reads: the run's terminal row. */
function persisted(outcome: RunOutcome | null): void {
  const end: RunEnd | null =
    outcome === null ? null : { outcome, output: emptyRunEndOutput('toolUse') };
  mocks.readRunEnd.mockReturnValue(Effect.succeed(end));
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

  it('reports the recorded outcome when the live handle is gone', async () => {
    persisted('cancelled');

    const liveness = await onSessionRuns(resolveRunLiveness(RUN_ID, session));

    assert.deepStrictEqual(liveness, { kind: 'settled', outcome: 'cancelled' });
  });

  it('reads no durable row and no claim for a run the caller already settled', async () => {
    // The listing's whole budget: one terminal row (here the caller's own),
    // and nothing else for a run that already said how it ended.
    persisted(null);

    const liveness = await onSessionRuns(
      resolveRunLiveness(RUN_ID, session, 'completed'),
    );

    assert.deepStrictEqual(liveness, { kind: 'settled', outcome: 'completed' });
    assert.strictEqual(mocks.readRunEnd.mock.calls.length, 0);
    assert.strictEqual(claimOwner.mock.calls.length, 0);
  });

  it('reports an outcome-less run a live foreign owner holds as held', async () => {
    // A background shell holds its run's claim for its whole lifetime and
    // records no outcome until it ends, so the claim is what decides it.
    persisted(null);
    claimOwner.mockReturnValue(
      Effect.succeed({ ownerId: foreignOwner(5150), liveness: 'alive' }),
    );

    const liveness = await onSessionRuns(
      resolveRunLiveness(RUN_ID, session, null),
    );

    assert.strictEqual(liveness.kind, 'unsettled');
    assert.match(
      liveness.kind === 'unsettled' ? liveness.reason : '',
      /pid 5150 on other-host/,
    );
  });

  it('calls a run nobody owns and nothing recorded interrupted', async () => {
    persisted(null);
    claimOwner.mockReturnValue(
      Effect.succeed({ ownerId: null, liveness: null }),
    );

    const liveness = await onSessionRuns(resolveRunLiveness(RUN_ID, session));

    // The two facts the arm was decided from, and nothing about whether
    // there is anything left to continue.
    assert.deepStrictEqual(liveness, { kind: 'interrupted' });
  });

  it('does not settle a run while another process holds it', async () => {
    persisted(null);
    claimOwner.mockReturnValue(
      Effect.succeed({ ownerId: foreignOwner(4242), liveness: 'alive' }),
    );

    const liveness = await onSessionRuns(resolveRunLiveness(RUN_ID, session));

    assert.strictEqual(liveness.kind, 'unsettled');
    assert.match(
      liveness.kind === 'unsettled' ? liveness.reason : '',
      /pid 4242 on other-host/,
    );
  });

  it('does not settle a run whose claim this process holds with no run', async () => {
    // Nothing durable behind the claim: no outcome ever written.
    persisted(null);
    claimOwner.mockReturnValue(
      Effect.succeed({ ownerId: foreignOwner(process.pid), liveness: 'self' }),
    );

    const liveness = await onSessionRuns(resolveRunLiveness(RUN_ID, session));

    assert.strictEqual(liveness.kind, 'unsettled');
    assert.match(
      liveness.kind === 'unsettled' ? liveness.reason : '',
      /no live run/,
    );
  });

  it('still reports the outcome while this process lags releasing the claim', async () => {
    // A finished child untracks its handle and writes the outcome long before
    // its loop releases the run's claim (#8093), and the parent reads the
    // run inside exactly that window.
    persisted('completed');
    claimOwner.mockReturnValue(
      Effect.succeed({ ownerId: foreignOwner(process.pid), liveness: 'self' }),
    );

    const liveness = await onSessionRuns(resolveRunLiveness(RUN_ID, session));

    assert.deepStrictEqual(liveness, { kind: 'settled', outcome: 'completed' });
  });

  it('reports an unreadable claim rather than a terminal reading', async () => {
    persisted(null);
    claimOwner.mockReturnValue(Effect.fail(new Error('claim unreadable')));

    const liveness = await onSessionRuns(resolveRunLiveness(RUN_ID, session));

    assert.strictEqual(liveness.kind, 'unsettled');
    assert.match(
      liveness.kind === 'unsettled' ? liveness.reason : '',
      /cannot read \(claim unreadable\)/,
    );
  });
});

describe('turnAttributionNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not call an accepted turn running once its run is terminal', async () => {
    // The handle outlives the run's terminal phase, so handle presence
    // alone must not word the note as "still running".
    const handle = testRunHandle({ runId: RUN_ID, agent: 'test' });
    session.runs.track(handle);
    await endRun('completed');
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
    await Effect.runPromise(
      session.commit([
        turnRow(1, 'accepted'),
        turnRow(1, 'settled'),
        turnRow(2, 'accepted'),
      ]),
    );

    const note = await onSessionRuns(turnAttributionNote(RUN_ID, session));

    assert.match(
      note ?? '',
      /turn 2 of attempt attempt-1 ended with its run \(completed\)/,
    );
    assert.match(note ?? '', /turn 1 of attempt attempt-1/);
    assert.doesNotMatch(note ?? '', /still running/);
  });
});
