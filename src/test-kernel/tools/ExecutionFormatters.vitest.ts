// Third-party imports
import * as assert from 'node:assert';
import { describe, it, vi } from 'vitest';

import type { RunOutcome } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  currentSession: vi.fn(),
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.currentSession,
}));

// Local imports
import { getExecutionStatusInfo } from '@tools/executionFormatters';

describe('getExecutionStatusInfo', () => {
  it.each<{ outcome?: RunOutcome; expected: string }>([
    { outcome: undefined, expected: 'unknown' },
    { outcome: 'cancelled', expected: 'cancelled' },
  ])(
    'reports $expected when the live handle is gone',
    ({ outcome, expected }) => {
      mocks.currentSession.mockReturnValue({
        executions: { getHandle: () => undefined },
      });

      const info = getExecutionStatusInfo('exec-1', outcome);

      assert.strictEqual(info.status, expected);
    },
  );
});
