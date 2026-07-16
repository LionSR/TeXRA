import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storageMocks = vi.hoisted(() => ({
  touchExecutionHeartbeat: vi.fn(() => Promise.resolve()),
}));

vi.mock('@agent/storage', () => ({
  HEARTBEAT_INTERVAL_MS: 10_000,
  touchExecutionHeartbeat: storageMocks.touchExecutionHeartbeat,
  finalizeExecution: vi.fn(),
  synchronizeAgentResultOutcome: vi.fn(),
}));

import { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import type { ExecutionHandle } from '@agent/runtime/executionRegistry';

function fakeHandle(executionId: string): ExecutionHandle {
  return { executionId } as ExecutionHandle;
}

describe('ExecutionRegistry heartbeat timer (#8625)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storageMocks.touchExecutionHeartbeat.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('touches immediately on track and on every interval while active', () => {
    const registry = new ExecutionRegistry();
    registry.track(fakeHandle('aaa111'));
    expect(storageMocks.touchExecutionHeartbeat).toHaveBeenCalledWith('aaa111');

    registry.track(fakeHandle('bbb222'));
    storageMocks.touchExecutionHeartbeat.mockClear();

    vi.advanceTimersByTime(10_000);
    const touched = storageMocks.touchExecutionHeartbeat.mock.calls.flat();
    expect(touched).toEqual(['aaa111', 'bbb222']);

    registry.dispose();
  });

  it('stops touching once the last handle untracks', () => {
    const registry = new ExecutionRegistry();
    registry.track(fakeHandle('ccc333'));
    registry.untrack('ccc333');
    storageMocks.touchExecutionHeartbeat.mockClear();

    vi.advanceTimersByTime(60_000);
    expect(storageMocks.touchExecutionHeartbeat).not.toHaveBeenCalled();

    registry.dispose();
  });
});
