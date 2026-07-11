import { describe, expect, it, vi } from 'vitest';

import {
  AgentExecutionHandle,
  ExecutionRegistry,
} from '@agent/runtime/executionRegistry';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { AgentCliSessionRegistry } from '@tools/agentCliSessionRegistry';
import { createRecordingHost } from '../agent/progressTestUtils';

describe('AgentCliSessionRegistry', () => {
  it('atomically claims a session id and wakes waiters when it becomes active', async () => {
    const registry = new AgentCliSessionRegistry('test_session_id');
    const executions = new ExecutionRegistry();
    const entry = {
      childStreamId: 'child-a' as StreamTabId,
      executionId: 'execution-a' as ExecutionId,
      executions,
    };

    try {
      const releaseInitialClaim = registry.claim('session-a');
      expect(releaseInitialClaim).toBeTypeOf('function');
      expect(registry.claim('session-a')).toBeUndefined();
      expect(registry.isActive('session-a')).toBe(false);
      expect(registry.lookup('session-a')).toBeUndefined();

      const active = registry.waitForActive('session-a');
      registry.register('session-a', entry);

      await expect(active).resolves.toBe(entry);
      expect(registry.isActive('session-a')).toBe(true);
      expect(registry.lookup('session-a')).toBe(entry);
      expect(registry.claim('session-a')).toBeUndefined();

      // The original release handle owns only the reservation. Promotion to
      // active makes it harmless, so a late launch failure cannot strand the
      // running loop by deleting its registry entry.
      releaseInitialClaim?.();
      expect(registry.lookup('session-a')).toBe(entry);

      registry.release('session-a');
      expect(registry.isActive('session-a')).toBe(false);
      const releaseNextClaim = registry.claim('session-a');
      expect(releaseNextClaim).toBeTypeOf('function');
      releaseInitialClaim?.();
      expect(registry.claim('session-a')).toBeUndefined();
      releaseNextClaim?.();
    } finally {
      registry.release('session-a');
      executions.dispose();
    }
  });

  it('releases pending waiters and permits a new claim after cleanup', async () => {
    const registry = new AgentCliSessionRegistry('test_session_id');

    const releaseClaim = registry.claim('session-a');
    expect(releaseClaim).toBeTypeOf('function');
    const active = registry.waitForActive('session-a');

    releaseClaim?.();

    await expect(active).resolves.toBeUndefined();
    expect(registry.isActive('session-a')).toBe(false);
    const releaseNextClaim = registry.claim('session-a');
    expect(releaseNextClaim).toBeTypeOf('function');

    releaseNextClaim?.();
    await expect(registry.waitForActive('session-a')).resolves.toBeUndefined();
  });

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
      registry.claim('pending-session');
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
      registry.release('pending-session');
      ownerA.dispose();
      ownerB.dispose();
    }
  });
});
