// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { noopTrace } from '@agent/trace';
import { AgentLaunchResources } from '@agent/runtime/AgentLaunchResources';

describe('AgentLaunchResources', () => {
  it('retains raw-trace ownership when session attachment throws', () => {
    const resources = new AgentLaunchResources();
    const unattachedTrace = {
      trace: noopTrace,
      handleStatus: vi.fn(),
      dispose: vi.fn(),
    };
    expect(() =>
      resources.ownRunTrace(unattachedTrace, () => {
        throw new Error('attach failed');
      }),
    ).toThrow('attach failed');
    resources.fail(() => undefined);
    expect(unattachedTrace.dispose).toHaveBeenCalledOnce();
  });
});
