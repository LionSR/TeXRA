import { describe, expect, it, vi } from 'vitest';

import {
  AgentExecutionHandle,
  ExecutionRegistry,
} from '@agent/runtime/executionRegistry';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { AgentCliSessionRegistry } from '@tools/agentCliSessionRegistry';
import { createRecordingHost } from '../agent/progressTestUtils';

describe('AgentCliSessionRegistry', () => {
  it('interrupts each child through the execution registry that owns the session', () => {
    const registry = new AgentCliSessionRegistry('test_session_id');
    const ownerA = new ExecutionRegistry();
    const ownerB = new ExecutionRegistry();
    const interruptA = vi.fn();
    const interruptB = vi.fn();
    const host = createRecordingHost().host;

    const handleA = new AgentExecutionHandle(
      'execution-a',
      'parent-a' as StreamTabId,
      'child-a' as StreamTabId,
      'codex',
      'toolUse',
      host,
    );
    handleA.attachInterruptHandler({ interrupt: interruptA });
    ownerA.track(handleA);
    const handleB = new AgentExecutionHandle(
      'execution-b',
      'parent-b' as StreamTabId,
      'child-b' as StreamTabId,
      'claude',
      'toolUse',
      host,
    );
    handleB.attachInterruptHandler({ interrupt: interruptB });
    ownerB.track(handleB);

    try {
      registry.register('session-a', {
        childStreamId: 'child-a' as StreamTabId,
        executionId: 'execution-a' as ExecutionId,
        executions: ownerA,
      });
      registry.register('session-b', {
        childStreamId: 'child-b' as StreamTabId,
        executionId: 'execution-b' as ExecutionId,
        executions: ownerB,
      });

      registry.interruptAll();

      expect(interruptA).toHaveBeenCalledOnce();
      expect(interruptB).toHaveBeenCalledOnce();
    } finally {
      ownerA.dispose();
      ownerB.dispose();
    }
  });
});
