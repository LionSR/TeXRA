// Third-party imports
import * as assert from 'node:assert';
import { it } from '@effect/vitest';
import { beforeEach, afterEach, describe, vi } from 'vitest';
import { Effect } from 'effect';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunOutcome } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { seedStreamStatusForTest } from '@test/support/streamStatusTestUtils';

const mocks = vi.hoisted(() => ({
  inspectExecutionLease: vi.fn(),
  readMeta: vi.fn(),
  exists: vi.fn(),
}));

vi.mock('@agent/storage/executionLease', () => ({
  inspectRunLease: mocks.inspectExecutionLease,
}));

vi.mock('@agent/storage/ExecutionKVStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/ExecutionKVStore')>()),
  getRunStore: () => ({ exists: mocks.exists }),
  getRunRecords: () => ({ readMeta: mocks.readMeta }),
}));

// Local imports
import { getExecutionStatusInfo } from '@tools/executionFormatters';
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

describe('getExecutionStatusInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Unowned unless a case says otherwise: every outcome-less row reads the
    // lease before it decides anything from the checkpoint.
    mocks.inspectExecutionLease.mockResolvedValue({ status: 'free' });
  });

  it.effect.each<{ outcome?: RunOutcome; expected: string }>([
    { outcome: undefined, expected: 'unknown' },
    { outcome: 'cancelled', expected: 'cancelled' },
  ])(
    'reports $expected when the live handle is gone and nothing owns the run',
    ({ outcome, expected }) =>
      Effect.gen(function* () {
        persisted({ outcome }, 'no-checkpoint');

        const info = yield* getExecutionStatusInfo('exec-1', session);

        assert.strictEqual(info.status, expected);
      }),
  );

  it.effect(
    'reads no checkpoint and no lease for a row that recorded its outcome',
    () =>
      Effect.gen(function* () {
        // The listing's whole budget: one metadata row (here the caller's own),
        // and nothing else for a run that already said how it ended.
        persisted(null, 'no-checkpoint');

        const info = yield* getExecutionStatusInfo('exec-1', session, {
          outcome: 'completed',
        });

        assert.strictEqual(info.status, 'completed');
        assert.strictEqual(mocks.readMeta.mock.calls.length, 0);
        assert.strictEqual(mocks.exists.mock.calls.length, 0);
        assert.strictEqual(mocks.inspectExecutionLease.mock.calls.length, 0);
      }),
  );

  it.effect('costs one lease read and one stat for a settled row', () =>
    Effect.gen(function* () {
      persisted({}, 'no-checkpoint');

      const info = yield* getExecutionStatusInfo('exec-1', session, {});

      assert.strictEqual(info.status, 'unknown');
      assert.strictEqual(mocks.readMeta.mock.calls.length, 0);
      assert.strictEqual(mocks.inspectExecutionLease.mock.calls.length, 1);
      assert.strictEqual(mocks.exists.mock.calls.length, 1);
    }),
  );

  it.effect(
    'reports a checkpointless run a live foreign owner holds as held',
    () =>
      Effect.gen(function* () {
        // A background shell holds its execution lease for its whole lifetime and
        // never writes a flow record, so the checkpoint stat cannot decide it.
        persisted({}, 'no-checkpoint');
        mocks.inspectExecutionLease.mockResolvedValue({
          status: 'held',
          owner: { pid: 5150, hostname: 'other-host' },
        });

        const info = yield* getExecutionStatusInfo('exec-1', session, {});

        assert.strictEqual(info.status, 'unknown');
        assert.match(info.detail ?? '', /pid 5150 on other-host/);
        assert.strictEqual(mocks.exists.mock.calls.length, 0);
      }),
  );

  it.effect('calls a checkpointed run nobody owns interrupted', () =>
    Effect.gen(function* () {
      persisted({}, 'checkpoint');
      mocks.inspectExecutionLease.mockResolvedValue({ status: 'free' });

      const info = yield* getExecutionStatusInfo('exec-1', session);

      assert.strictEqual(info.status, 'cancelled');
      // Presence, not validity: a stat cannot promise the record can be resumed.
      assert.match(
        info.detail ?? '',
        /interrupted; a flow record remains \(not validated here\)/,
      );
    }),
  );

  it.effect(
    'does not call a run cancelled while another process holds it',
    () =>
      Effect.gen(function* () {
        persisted({}, 'checkpoint');
        mocks.inspectExecutionLease.mockResolvedValue({
          status: 'held',
          owner: { pid: 4242, hostname: 'other-host' },
        });

        const info = yield* getExecutionStatusInfo('exec-1', session);

        assert.strictEqual(info.status, 'unknown');
        assert.match(info.detail ?? '', /pid 4242 on other-host/);
      }),
  );

  it.effect(
    'does not settle a run whose lease this process holds with no run',
    () =>
      Effect.gen(function* () {
        // Nothing durable behind the lease: no outcome ever written.
        persisted({}, 'checkpoint');
        mocks.inspectExecutionLease.mockResolvedValue({ status: 'owned' });

        const info = yield* getExecutionStatusInfo('exec-1', session);

        assert.strictEqual(info.status, 'unknown');
        assert.match(info.detail ?? '', /no live run/);
      }),
  );

  it.effect(
    'still reports the outcome while this process lags releasing the lease',
    () =>
      Effect.gen(function* () {
        // A finished child untracks its handle and writes the outcome long before
        // its loop releases the execution lease (#8093), and the parent reads the
        // run inside exactly that window.
        persisted({ outcome: 'completed' }, 'checkpoint');
        mocks.inspectExecutionLease.mockResolvedValue({ status: 'owned' });

        const info = yield* getExecutionStatusInfo('exec-1', session);

        assert.strictEqual(info.status, 'completed');
      }),
  );

  it.effect('reports an unreadable lease rather than a terminal reading', () =>
    Effect.gen(function* () {
      persisted({}, 'checkpoint');
      mocks.inspectExecutionLease.mockRejectedValue(new Error('lease corrupt'));

      const info = yield* getExecutionStatusInfo('exec-1', session);

      assert.strictEqual(info.status, 'unknown');
      assert.match(info.detail ?? '', /cannot read \(lease corrupt\)/);
    }),
  );
});

describe('turnAttributionNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.effect(
    'does not call an accepted turn running once its stream is terminal',
    () =>
      Effect.gen(function* () {
        // The handle outlives the stream's terminal phase, so handle presence
        // alone must not word the note as "still running".
        const handle = testExecutionHandle({
          executionId: 'exec-1',
          parentStreamId: 'stream-1',
          agent: 'test',
        });
        session.executions.track(handle);
        seedStreamStatusForTest(session.status, 'stream-1', {
          phase: 'completed',
        });
        const store = {
          getExecutionId: () => 'exec-1',
          readTurnState: async () => ({
            activeTurn: { token: 'turn-2' },
            lastCompletedTurn: { token: 'turn-1' },
          }),
        } as unknown as Parameters<typeof turnAttributionNote>[0];

        const note = yield* turnAttributionNote(store, session);

        assert.match(
          note ?? '',
          /turn turn-2 ended with its run \(completed\)/,
        );
        assert.doesNotMatch(note ?? '', /still running/);
      }),
  );
});
