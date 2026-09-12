// Third-party imports
import * as assert from 'node:assert';
import { beforeEach, afterEach, describe, it, vi } from 'vitest';
import { Effect } from 'effect';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  emptyRunEndOutput,
  RunIdSchema,
  type RunEnd,
  type RunOutcome,
} from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';

const RUN_ID = RunIdSchema.parse('ec1000000001');

const mocks = vi.hoisted(() => ({
  inspectRunLease: vi.fn(),
  readRunEnd: vi.fn(),
}));

vi.mock('@agent/storage/runLease', () => ({
  inspectRunLease: mocks.inspectRunLease,
}));

vi.mock('@agent/storage/RunKVStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/RunKVStore')>()),
  getRunRecords: () => ({ readRunEnd: mocks.readRunEnd }),
}));

// Local imports
import { getRunStatusInfo } from '@tools/executionFormatters';
import { turnAttributionNote } from '@tools/executions/turnAttribution';

let session: SessionHandle;
beforeEach(() => {
  session = createTestSession();
});
afterEach(() => {
  session.dispose();
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

describe('getRunStatusInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Unowned unless a case says otherwise: the lease is the only thing an
    // outcome-less row has left to ask.
    mocks.inspectRunLease.mockResolvedValue({ status: 'free' });
  });

  it('reports the recorded outcome when the live handle is gone', async () => {
    persisted('cancelled');

    const info = await Effect.runPromise(getRunStatusInfo(RUN_ID, session));

    assert.strictEqual(info.status, 'cancelled');
  });

  it('reads no durable row and no lease for a run the caller already settled', async () => {
    // The listing's whole budget: one terminal row (here the caller's own),
    // and nothing else for a run that already said how it ended.
    persisted(null);

    const info = await Effect.runPromise(
      getRunStatusInfo(RUN_ID, session, 'completed'),
    );

    assert.strictEqual(info.status, 'completed');
    assert.strictEqual(mocks.readRunEnd.mock.calls.length, 0);
    assert.strictEqual(mocks.inspectRunLease.mock.calls.length, 0);
  });

  it('reports an outcome-less run a live foreign owner holds as held', async () => {
    // A background shell holds its run lease for its whole lifetime and
    // records no outcome until it ends, so the claim is what decides it.
    persisted(null);
    mocks.inspectRunLease.mockResolvedValue({
      status: 'held',
      owner: { pid: 5150, hostname: 'other-host' },
    });

    const info = await Effect.runPromise(
      getRunStatusInfo(RUN_ID, session, null),
    );

    assert.strictEqual(info.status, 'unknown');
    assert.match(info.detail ?? '', /pid 5150 on other-host/);
  });

  it('calls a run nobody owns and nothing recorded interrupted', async () => {
    persisted(null);
    mocks.inspectRunLease.mockResolvedValue({ status: 'free' });

    const info = await Effect.runPromise(getRunStatusInfo(RUN_ID, session));

    assert.strictEqual(info.status, 'cancelled');
    // The two facts the arm was decided from, and nothing about whether
    // there is anything left to continue.
    assert.match(
      info.detail ?? '',
      /interrupted; no owner and no recorded outcome/,
    );
  });

  it('does not call a run cancelled while another process holds it', async () => {
    persisted(null);
    mocks.inspectRunLease.mockResolvedValue({
      status: 'held',
      owner: { pid: 4242, hostname: 'other-host' },
    });

    const info = await Effect.runPromise(getRunStatusInfo(RUN_ID, session));

    assert.strictEqual(info.status, 'unknown');
    assert.match(info.detail ?? '', /pid 4242 on other-host/);
  });

  it('does not settle a run whose lease this process holds with no run', async () => {
    // Nothing durable behind the lease: no outcome ever written.
    persisted(null);
    mocks.inspectRunLease.mockResolvedValue({ status: 'owned' });

    const info = await Effect.runPromise(getRunStatusInfo(RUN_ID, session));

    assert.strictEqual(info.status, 'unknown');
    assert.match(info.detail ?? '', /no live run/);
  });

  it('still reports the outcome while this process lags releasing the lease', async () => {
    // A finished child untracks its handle and writes the outcome long before
    // its loop releases the run lease (#8093), and the parent reads the
    // run inside exactly that window.
    persisted('completed');
    mocks.inspectRunLease.mockResolvedValue({ status: 'owned' });

    const info = await Effect.runPromise(getRunStatusInfo(RUN_ID, session));

    assert.strictEqual(info.status, 'completed');
  });

  it('reports an unreadable lease rather than a terminal reading', async () => {
    persisted(null);
    mocks.inspectRunLease.mockRejectedValue(new Error('lease corrupt'));

    const info = await Effect.runPromise(getRunStatusInfo(RUN_ID, session));

    assert.strictEqual(info.status, 'unknown');
    assert.match(info.detail ?? '', /cannot read \(lease corrupt\)/);
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
    const store = {
      getRunId: () => RUN_ID,
      readTurnState: async () => ({
        activeTurn: { token: 'turn-2' },
        lastCompletedTurn: { token: 'turn-1' },
      }),
    } as unknown as Parameters<typeof turnAttributionNote>[0];

    const note = await Effect.runPromise(turnAttributionNote(store, session));

    assert.match(note ?? '', /turn turn-2 ended with its run \(completed\)/);
    assert.doesNotMatch(note ?? '', /still running/);
  });
});
