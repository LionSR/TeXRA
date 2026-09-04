// Third-party imports
import * as assert from 'node:assert';
import { describe, it, vi } from 'vitest';

import type { RunOutcome } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  currentSession: vi.fn(),
  inspectExecutionLease: vi.fn(),
  exists: vi.fn(),
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.currentSession,
}));

vi.mock('@agent/storage/executionLease', () => ({
  inspectExecutionLease: mocks.inspectExecutionLease,
}));

vi.mock('@agent/storage/ExecutionKVStore', () => ({
  getExecutionStore: () => ({ exists: mocks.exists }),
}));

// Local imports
import { getExecutionStatusInfo } from '@tools/executionFormatters';

describe('getExecutionStatusInfo', () => {
  it.each<{ outcome?: RunOutcome; expected: string }>([
    { outcome: undefined, expected: 'unknown' },
    { outcome: 'cancelled', expected: 'cancelled' },
  ])(
    'reports $expected when the live handle is gone and nothing owns the run',
    async ({ outcome, expected }) => {
      mocks.currentSession.mockReturnValue({
        executions: { getHandle: () => undefined },
      });
      mocks.inspectExecutionLease.mockResolvedValue({ status: 'free' });
      mocks.exists.mockResolvedValue(false);

      const info = await getExecutionStatusInfo('exec-1', outcome);

      assert.strictEqual(info.status, expected);
    },
  );

  it('does not call a run cancelled while another process holds it', async () => {
    mocks.currentSession.mockReturnValue({
      executions: { getHandle: () => undefined },
    });
    mocks.inspectExecutionLease.mockResolvedValue({
      status: 'held',
      owner: { pid: 4242, hostname: 'other-host' },
    });

    const info = await getExecutionStatusInfo('exec-1');

    assert.strictEqual(info.status, 'unknown');
    assert.match(info.detail ?? '', /pid 4242 on other-host/);
  });
});
