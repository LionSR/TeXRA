// Third-party imports
import * as assert from 'node:assert';
import { describe, it, vi } from 'vitest';

import type { RunOutcome } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  currentSession: vi.fn(),
  inspectExecutionLease: vi.fn(),
  read: vi.fn(),
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.currentSession,
}));

vi.mock('@agent/storage/executionLease', () => ({
  inspectExecutionLease: mocks.inspectExecutionLease,
}));

vi.mock('@agent/storage/ExecutionKVStore', () => ({
  getExecutionStore: () => ({ read: mocks.read }),
}));

// Local imports
import { getExecutionStatusInfo } from '@tools/executionFormatters';

/** No handle in this process, whatever the durable facts then say. */
function noLiveHandle(): void {
  mocks.currentSession.mockReturnValue({
    executions: { getHandle: () => undefined },
  });
}

/** Persisted facts: the given metadata and no checkpoint. */
function persistedMeta(meta: { outcome?: RunOutcome } | undefined): void {
  mocks.read.mockImplementation((key: string) =>
    Promise.resolve(
      key === 'meta' && meta
        ? { timestamp: '2026-05-15T23:42:06.000Z', ...meta }
        : undefined,
    ),
  );
}

describe('getExecutionStatusInfo', () => {
  it.each<{ outcome?: RunOutcome; expected: string }>([
    { outcome: undefined, expected: 'unknown' },
    { outcome: 'cancelled', expected: 'cancelled' },
  ])(
    'reports $expected when the live handle is gone and nothing owns the run',
    async ({ outcome, expected }) => {
      noLiveHandle();
      mocks.inspectExecutionLease.mockResolvedValue({ status: 'free' });
      // The persisted metadata is the only outcome source — no caller passes a
      // snapshot in. No flow record, so `classifyRun` reports `finished`.
      persistedMeta({ outcome });

      const info = await getExecutionStatusInfo('exec-1');

      assert.strictEqual(info.status, expected);
    },
  );

  it('does not call a run cancelled while another process holds it', async () => {
    noLiveHandle();
    persistedMeta(undefined);
    mocks.inspectExecutionLease.mockResolvedValue({
      status: 'held',
      owner: { pid: 4242, hostname: 'other-host' },
    });

    const info = await getExecutionStatusInfo('exec-1');

    assert.strictEqual(info.status, 'unknown');
    assert.match(info.detail ?? '', /pid 4242 on other-host/);
  });

  it('does not settle a run whose lease this process holds with no run', async () => {
    noLiveHandle();
    // Nothing durable behind the lease: no outcome ever written.
    persistedMeta({});
    mocks.inspectExecutionLease.mockResolvedValue({ status: 'owned' });

    const info = await getExecutionStatusInfo('exec-1');

    assert.strictEqual(info.status, 'unknown');
    assert.match(info.detail ?? '', /no live run/);
  });

  it('still reports the outcome while this process lags releasing the lease', async () => {
    // A finished child untracks its handle and writes the outcome long before
    // its loop releases the execution lease (#8093), and the parent reads the
    // run inside exactly that window.
    noLiveHandle();
    persistedMeta({ outcome: 'completed' });
    mocks.inspectExecutionLease.mockResolvedValue({ status: 'owned' });

    const info = await getExecutionStatusInfo('exec-1');

    assert.strictEqual(info.status, 'completed');
  });
});
