// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - tools
import { agentCliLoopTerminalStatus } from '@tools/agentCliShared';

describe('agent CLI loop status', () => {
  it('maps loop failure state to persisted terminal status', () => {
    expect(
      agentCliLoopTerminalStatus({
        interrupted: false,
        sawTurnFailure: false,
      }),
    ).toBe('completed');
    expect(
      agentCliLoopTerminalStatus({
        interrupted: true,
        sawTurnFailure: false,
      }),
    ).toBe('interrupted');
    expect(
      agentCliLoopTerminalStatus({
        interrupted: false,
        sawTurnFailure: true,
      }),
    ).toBe('error');
    expect(
      agentCliLoopTerminalStatus({
        interrupted: true,
        sawTurnFailure: true,
      }),
    ).toBe('error');
  });
});
