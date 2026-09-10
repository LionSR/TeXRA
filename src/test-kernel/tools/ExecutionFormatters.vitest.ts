// Third-party imports
import * as assert from 'node:assert';
import { beforeEach, afterEach, describe, it, vi } from 'vitest';
import { Effect } from 'effect';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunOutcome } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { seedRunStatusForTest } from '@test/support/runStatusTestUtils';

const mocks = vi.hoisted(() => ({
  inspectRunLease: vi.fn(),
  readMeta: vi.fn(),
  exists: vi.fn(),
}));

vi.mock('@agent/storage/runLease', () => ({
  inspectRunLease: mocks.inspectRunLease,
}));

vi.mock('@agent/storage/RunKVStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/RunKVStore')>()),
  getRunStore: () => ({ exists: mocks.exists }),
  getRunRecords: () => ({ readMeta: mocks.readMeta }),
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

/** Persisted facts: the given metadata row, and whether a checkpoint is on disk. */
function persisted(
  meta: { outcome?: RunOutcome } | null,
  checkpoint: 'checkpoint' | 'no-checkpoint',
): void {
  mocks.readMeta.mockReturnValue(
    Effect.succeed(meta && { timestamp: '2026-05-15T23:42:06.000Z', ...meta }),
  );
  mocks.exists.mockResolvedValue(checkpoint === 'checkpoint');
}

describe('getRunStatusInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Unowned unless a case says otherwise: every outcome-less row reads the
    // lease before it decides anything from the checkpoint.
    mocks.inspectRunLease.mockResolvedValue({ status: 'free' });
  });

  it.each<{ outcome?: RunOutcome; expected: string }>([
    { outcome: undefined, expected: 'unknown' },
    { outcome: 'cancelled', expected: 'cancelled' },
  ])(
    'reports $expected when the live handle is gone and nothing owns the run',
    async ({ outcome, expected }) => {
      persisted({ outcome }, 'no-checkpoint');

      const info = await Effect.runPromise(
        getRunStatusInfo('exec-1', session),
      );

      assert.strictEqual(info.status, expected);
    },
  );

  it('reads no checkpoint and no lease for a row that recorded its outcome', async () => {
    // The listing's whole budget: one metadata row (here the caller's own),
    // and nothing else for a run that already said how it ended.
    persisted(null, 'no-checkpoint');

    const info = await Effect.runPromise(
      getRunStatusInfo('exec-1', session, {
        outcome: 'completed',
      }),
    );

    assert.strictEqual(info.status, 'completed');
    assert.strictEqual(mocks.readMeta.mock.calls.length, 0);
    assert.strictEqual(mocks.exists.mock.calls.length, 0);
    assert.strictEqual(mocks.inspectRunLease.mock.calls.length, 0);
  });

  it('costs one lease read and one stat for a settled row', async () => {
    persisted({}, 'no-checkpoint');

    const info = await Effect.runPromise(
      getRunStatusInfo('exec-1', session, {}),
    );

    assert.strictEqual(info.status, 'unknown');
    assert.strictEqual(mocks.readMeta.mock.calls.length, 0);
    assert.strictEqual(mocks.inspectRunLease.mock.calls.length, 1);
    assert.strictEqual(mocks.exists.mock.calls.length, 1);
  });

  it('reports a checkpointless run a live foreign owner holds as held', async () => {
    // A background shell holds its run lease for its whole lifetime and
    // never writes a flow record, so the checkpoint stat cannot decide it.
    persisted({}, 'no-checkpoint');
    mocks.inspectRunLease.mockResolvedValue({
      status: 'held',
      owner: { pid: 5150, hostname: 'other-host' },
    });

    const info = await Effect.runPromise(
      getRunStatusInfo('exec-1', session, {}),
    );

    assert.strictEqual(info.status, 'unknown');
    assert.match(info.detail ?? '', /pid 5150 on other-host/);
    assert.strictEqual(mocks.exists.mock.calls.length, 0);
  });

  it('calls a checkpointed run nobody owns interrupted', async () => {
    persisted({}, 'checkpoint');
    mocks.inspectRunLease.mockResolvedValue({ status: 'free' });

    const info = await Effect.runPromise(
      getRunStatusInfo('exec-1', session),
    );

    assert.strictEqual(info.status, 'cancelled');
    // Presence, not validity: a stat cannot promise the record can be resumed.
    assert.match(
      info.detail ?? '',
      /interrupted; a flow record remains \(not validated here\)/,
    );
  });

  it('does not call a run cancelled while another process holds it', async () => {
    persisted({}, 'checkpoint');
    mocks.inspectRunLease.mockResolvedValue({
      status: 'held',
      owner: { pid: 4242, hostname: 'other-host' },
    });

    const info = await Effect.runPromise(
      getRunStatusInfo('exec-1', session),
    );

    assert.strictEqual(info.status, 'unknown');
    assert.match(info.detail ?? '', /pid 4242 on other-host/);
  });

  it('does not settle a run whose lease this process holds with no run', async () => {
    // Nothing durable behind the lease: no outcome ever written.
    persisted({}, 'checkpoint');
    mocks.inspectRunLease.mockResolvedValue({ status: 'owned' });

    const info = await Effect.runPromise(
      getRunStatusInfo('exec-1', session),
    );

    assert.strictEqual(info.status, 'unknown');
    assert.match(info.detail ?? '', /no live run/);
  });

  it('still reports the outcome while this process lags releasing the lease', async () => {
    // A finished child untracks its handle and writes the outcome long before
    // its loop releases the run lease (#8093), and the parent reads the
    // run inside exactly that window.
    persisted({ outcome: 'completed' }, 'checkpoint');
    mocks.inspectRunLease.mockResolvedValue({ status: 'owned' });

    const info = await Effect.runPromise(
      getRunStatusInfo('exec-1', session),
    );

    assert.strictEqual(info.status, 'completed');
  });

  it('reports an unreadable lease rather than a terminal reading', async () => {
    persisted({}, 'checkpoint');
    mocks.inspectRunLease.mockRejectedValue(new Error('lease corrupt'));

    const info = await Effect.runPromise(
      getRunStatusInfo('exec-1', session),
    );

    assert.strictEqual(info.status, 'unknown');
    assert.match(info.detail ?? '', /cannot read \(lease corrupt\)/);
  });
});

describe('turnAttributionNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not call an accepted turn running once its stream is terminal', async () => {
    // The handle outlives the stream's terminal phase, so handle presence
    // alone must not word the note as "still running".
    const handle = testRunHandle({
      runId: 'exec-1',
      parentRunId: 'stream-1',
      agent: 'test',
    });
    session.runs.track(handle);
    seedRunStatusForTest(session.status, 'stream-1', { phase: 'completed' });
    const store = {
      getRunId: () => 'exec-1',
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
