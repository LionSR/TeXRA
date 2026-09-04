// Third-party imports
import * as assert from 'node:assert';
import { beforeEach, describe, it, vi } from 'vitest';

import type { RunOutcome } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  currentSession: vi.fn(),
  inspectExecutionLease: vi.fn(),
  readMeta: vi.fn(),
  exists: vi.fn(),
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.currentSession,
}));

vi.mock('@agent/storage/executionLease', () => ({
  inspectExecutionLease: mocks.inspectExecutionLease,
}));

vi.mock('@agent/storage/ExecutionKVStore', () => ({
  getExecutionStore: () => ({ readMeta: mocks.readMeta, exists: mocks.exists }),
}));

// Local imports
import { getExecutionStatusInfo } from '@tools/executionFormatters';
import { turnAttributionNote } from '@tools/executions/turnAttribution';

/** No handle in this process, whatever the durable facts then say. */
function noLiveHandle(): void {
  mocks.currentSession.mockReturnValue({
    executions: { getHandle: () => undefined },
  });
}

/** Persisted facts: the given metadata row, and whether a checkpoint is on disk. */
function persisted(
  meta: { outcome?: RunOutcome } | null,
  checkpoint: 'checkpoint' | 'no-checkpoint',
): void {
  mocks.readMeta.mockResolvedValue(
    meta && { timestamp: '2026-05-15T23:42:06.000Z', ...meta },
  );
  mocks.exists.mockResolvedValue(checkpoint === 'checkpoint');
}

describe('getExecutionStatusInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noLiveHandle();
    // Unowned unless a case says otherwise: every outcome-less row reads the
    // lease before it decides anything from the checkpoint.
    mocks.inspectExecutionLease.mockResolvedValue({ status: 'free' });
  });

  it.each<{ outcome?: RunOutcome; expected: string }>([
    { outcome: undefined, expected: 'unknown' },
    { outcome: 'cancelled', expected: 'cancelled' },
  ])(
    'reports $expected when the live handle is gone and nothing owns the run',
    async ({ outcome, expected }) => {
      persisted({ outcome }, 'no-checkpoint');

      const info = await getExecutionStatusInfo('exec-1');

      assert.strictEqual(info.status, expected);
    },
  );

  it('reads no checkpoint and no lease for a row that recorded its outcome', async () => {
    // The listing's whole budget: one metadata row (here the caller's own),
    // and nothing else for a run that already said how it ended.
    persisted(null, 'no-checkpoint');

    const info = await getExecutionStatusInfo('exec-1', {
      outcome: 'completed',
    });

    assert.strictEqual(info.status, 'completed');
    assert.strictEqual(mocks.readMeta.mock.calls.length, 0);
    assert.strictEqual(mocks.exists.mock.calls.length, 0);
    assert.strictEqual(mocks.inspectExecutionLease.mock.calls.length, 0);
  });

  it('costs one lease read and one stat for a settled row', async () => {
    persisted({}, 'no-checkpoint');

    const info = await getExecutionStatusInfo('exec-1', {});

    assert.strictEqual(info.status, 'unknown');
    assert.strictEqual(mocks.readMeta.mock.calls.length, 0);
    assert.strictEqual(mocks.inspectExecutionLease.mock.calls.length, 1);
    assert.strictEqual(mocks.exists.mock.calls.length, 1);
  });

  it('reports a checkpointless run a live foreign owner holds as held', async () => {
    // A background shell holds its execution lease for its whole lifetime and
    // never writes a flow record, so the checkpoint stat cannot decide it.
    persisted({}, 'no-checkpoint');
    mocks.inspectExecutionLease.mockResolvedValue({
      status: 'held',
      owner: { pid: 5150, hostname: 'other-host' },
    });

    const info = await getExecutionStatusInfo('exec-1', {});

    assert.strictEqual(info.status, 'unknown');
    assert.match(info.detail ?? '', /pid 5150 on other-host/);
    assert.strictEqual(mocks.exists.mock.calls.length, 0);
  });

  it('calls a checkpointed run nobody owns interrupted', async () => {
    persisted({}, 'checkpoint');
    mocks.inspectExecutionLease.mockResolvedValue({ status: 'free' });

    const info = await getExecutionStatusInfo('exec-1');

    assert.strictEqual(info.status, 'cancelled');
    // Presence, not validity: a stat cannot promise the record can be resumed.
    assert.match(
      info.detail ?? '',
      /interrupted; a flow record remains \(not validated here\)/,
    );
  });

  it('does not call a run cancelled while another process holds it', async () => {
    persisted({}, 'checkpoint');
    mocks.inspectExecutionLease.mockResolvedValue({
      status: 'held',
      owner: { pid: 4242, hostname: 'other-host' },
    });

    const info = await getExecutionStatusInfo('exec-1');

    assert.strictEqual(info.status, 'unknown');
    assert.match(info.detail ?? '', /pid 4242 on other-host/);
  });

  it('does not settle a run whose lease this process holds with no run', async () => {
    // Nothing durable behind the lease: no outcome ever written.
    persisted({}, 'checkpoint');
    mocks.inspectExecutionLease.mockResolvedValue({ status: 'owned' });

    const info = await getExecutionStatusInfo('exec-1');

    assert.strictEqual(info.status, 'unknown');
    assert.match(info.detail ?? '', /no live run/);
  });

  it('still reports the outcome while this process lags releasing the lease', async () => {
    // A finished child untracks its handle and writes the outcome long before
    // its loop releases the execution lease (#8093), and the parent reads the
    // run inside exactly that window.
    persisted({ outcome: 'completed' }, 'checkpoint');
    mocks.inspectExecutionLease.mockResolvedValue({ status: 'owned' });

    const info = await getExecutionStatusInfo('exec-1');

    assert.strictEqual(info.status, 'completed');
  });

  it('reports an unreadable lease rather than a terminal reading', async () => {
    persisted({}, 'checkpoint');
    mocks.inspectExecutionLease.mockRejectedValue(new Error('lease corrupt'));

    const info = await getExecutionStatusInfo('exec-1');

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
    mocks.currentSession.mockReturnValue({
      executions: {
        getHandle: () => ({}),
        getStatus: () => ({ status: 'completed', elapsed: null }),
      },
    });
    const store = {
      getExecutionId: () => 'exec-1',
      readTurnState: async () => ({
        activeTurn: { token: 'turn-2' },
        lastCompletedTurn: { token: 'turn-1' },
      }),
    } as unknown as Parameters<typeof turnAttributionNote>[0];

    const note = await turnAttributionNote(store);

    assert.match(note ?? '', /turn turn-2 ended with its run \(completed\)/);
    assert.doesNotMatch(note ?? '', /still running/);
  });
});
