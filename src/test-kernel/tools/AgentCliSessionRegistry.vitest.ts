import { describe, expect, it, vi } from 'vitest';

import { InterruptRegistry } from '@agent/runtime/InterruptRegistry';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { AgentCliSessionRegistry } from '@tools/agentCliSessionRegistry';

describe('AgentCliSessionRegistry', () => {
  it('interrupts each child through the registry that owns the session', () => {
    const registry = new AgentCliSessionRegistry('test_session_id');
    const ownerA = new InterruptRegistry();
    const ownerB = new InterruptRegistry();
    const interruptA = vi.fn();
    const interruptB = vi.fn();

    ownerA.register('child-a' as StreamTabId, { interrupt: interruptA });
    ownerB.register('child-b' as StreamTabId, { interrupt: interruptB });

    registry.register('session-a', {
      childStreamId: 'child-a' as StreamTabId,
      executionId: 'execution-a' as ExecutionId,
      interrupts: ownerA,
    });
    registry.register('session-b', {
      childStreamId: 'child-b' as StreamTabId,
      executionId: 'execution-b' as ExecutionId,
      interrupts: ownerB,
    });

    registry.interruptAll();

    expect(interruptA).toHaveBeenCalledOnce();
    expect(interruptB).toHaveBeenCalledOnce();
  });
});
