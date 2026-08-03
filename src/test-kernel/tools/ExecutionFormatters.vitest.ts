// Third-party imports
import * as assert from 'node:assert';
import { describe, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentSession: vi.fn(),
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.currentSession,
}));

// Local imports
import { getExecutionStatusInfo } from '@tools/executionFormatters';

describe('getExecutionStatusInfo', () => {
  it('reports unknown when the live handle is gone and terminalStatus is absent', () => {
    mocks.currentSession.mockReturnValue({
      executions: { getHandle: () => undefined },
    });

    const info = getExecutionStatusInfo('exec-1', undefined);

    assert.strictEqual(info.status, 'unknown');
  });

  it('reports unknown when terminalStatus fails to parse', () => {
    mocks.currentSession.mockReturnValue({
      executions: { getHandle: () => undefined },
    });

    const info = getExecutionStatusInfo('exec-2', 'not-a-real-status');

    assert.strictEqual(info.status, 'unknown');
  });
});
