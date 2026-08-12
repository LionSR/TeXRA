import { describe, expect, it, vi } from 'vitest';

import type { ExecutionId, StreamTabId } from '@shared/schemas';
import {
  testExecutionHandle,
  testExecutionRegistry,
} from '@test/support/executionHandleFixtures';
import { AgentCliSessionRegistry } from '@tools/agentCliSessionRegistry';

describe('AgentCliSessionRegistry', () => {
  it.each([
    {
      kind: 'rejected',
      makePersist: (error: Error) => vi.fn().mockRejectedValueOnce(error),
    },
    {
      kind: 'thrown',
      makePersist: (error: Error) =>
        vi.fn(() => {
          throw error;
        }),
    },
  ])(
    'contains a $kind session mapping write failure without awaiting registration',
    async ({ makePersist }) => {
      const executionId = 'execution-write-failure' as ExecutionId;
      const writeError = new Error('storage unavailable');
      const persistSessionId = makePersist(writeError);
      const reportPersistenceFailure = vi.fn();
      const registry = new AgentCliSessionRegistry('test_session_id', {
        persistSessionId,
        reportPersistenceFailure,
      });
      const executions = testExecutionRegistry();

      try {
        expect(
          registry.register('session-write-failure', {
            childStreamId: 'child-write-failure' as StreamTabId,
            executionId,
            executions,
          }),
        ).toBeUndefined();

        await vi.waitFor(() => {
          expect(reportPersistenceFailure).toHaveBeenCalledWith(
            executionId,
            writeError,
          );
        });
        expect(reportPersistenceFailure).toHaveBeenCalledOnce();
        expect(persistSessionId).toHaveBeenCalledOnce();
        expect(registry.lookup('session-write-failure')).toBeDefined();
      } finally {
        registry.release('session-write-failure');
        executions.dispose();
      }
    },
  );

  it('contains diagnostic failures after a rejected mapping write', async () => {
    const persistSessionId = vi
      .fn()
      .mockRejectedValueOnce(new Error('storage unavailable'));
    const registry = new AgentCliSessionRegistry('test_session_id', {
      persistSessionId,
      reportPersistenceFailure: () => {
        throw new Error('log sink unavailable');
      },
    });
    const executions = testExecutionRegistry();

    registry.register('session-log-failure', {
      childStreamId: 'child-log-failure' as StreamTabId,
      executionId: 'execution-log-failure' as ExecutionId,
      executions,
    });

    await vi.waitFor(() => expect(persistSessionId).toHaveBeenCalledOnce());
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.lookup('session-log-failure')).toBeDefined();
    registry.release('session-log-failure');
    executions.dispose();
  });

  it('atomically claims a session id and wakes waiters when it becomes active', async () => {
    const registry = new AgentCliSessionRegistry('test_session_id');
    const executions = testExecutionRegistry();
    const entry = {
      childStreamId: 'child-a' as StreamTabId,
      executionId: 'execution-a' as ExecutionId,
      executions,
    };

    try {
      const releaseInitialClaim = registry.claim('session-a');
      expect(releaseInitialClaim).toBeTypeOf('function');
      expect(registry.claim('session-a')).toBeUndefined();
      expect(registry.lookup('session-a')).toBeUndefined();

      const active = registry.waitForActive('session-a');
      registry.register('session-a', entry);

      await expect(active).resolves.toBe(entry);
      expect(registry.lookup('session-a')).toBe(entry);
      expect(registry.claim('session-a')).toBeUndefined();

      // The original release handle owns only the reservation. Promotion to
      // active makes it harmless, so a late launch failure cannot strand the
      // running loop by deleting its registry entry.
      releaseInitialClaim?.();
      expect(registry.lookup('session-a')).toBe(entry);

      registry.release('session-a');
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
    const releaseNextClaim = registry.claim('session-a');
    expect(releaseNextClaim).toBeTypeOf('function');

    releaseNextClaim?.();
    await expect(registry.waitForActive('session-a')).resolves.toBeUndefined();
  });

  it('releases every active alias owned by one execution', () => {
    const registry = new AgentCliSessionRegistry('test_session_id');
    const executions = testExecutionRegistry();
    const executionA = 'execution-a' as ExecutionId;
    const executionB = 'execution-b' as ExecutionId;
    const entry = (executionId: ExecutionId, childStreamId: StreamTabId) => ({
      childStreamId,
      executionId,
      executions,
    });
    const releasePending = registry.claim('pending-session');

    try {
      registry.register(
        'session-a',
        entry(executionA, 'child-a' as StreamTabId),
      );
      registry.register(
        'session-a-alias',
        entry(executionA, 'child-a' as StreamTabId),
      );
      registry.register(
        'session-b',
        entry(executionB, 'child-b' as StreamTabId),
      );

      registry.releaseByExecutionId(executionA);

      expect(registry.lookup('session-a')).toBeUndefined();
      expect(registry.lookup('session-a-alias')).toBeUndefined();
      expect(registry.lookup('session-b')?.executionId).toBe(executionB);
      expect(registry.claim('pending-session')).toBeUndefined();
    } finally {
      releasePending?.();
      registry.releaseByExecutionId(executionB);
      executions.dispose();
    }
  });

  it('interrupts an in-flight loop without promoting its reserved resume id', () => {
    const registry = new AgentCliSessionRegistry('test_session_id');
    const executionId = 'execution-in-flight' as ExecutionId;
    const interrupt = vi.fn();
    const releaseClaim = registry.claim('reserved-session');

    registry.trackInFlight({
      childStreamId: 'child-in-flight' as StreamTabId,
      executionId,
      executions: {
        getAgentHandleByStream: () => ({ interrupt }),
      } as any,
    });

    expect(registry.lookup('reserved-session')).toBeUndefined();
    registry.interruptAll();
    expect(interrupt).toHaveBeenCalledOnce();

    registry.releaseByExecutionId(executionId);
    registry.interruptAll();
    expect(interrupt).toHaveBeenCalledOnce();
    releaseClaim?.();
  });

  it('interrupts each child through the execution registry that owns the session', () => {
    const registry = new AgentCliSessionRegistry('test_session_id');
    const ownerA = testExecutionRegistry();
    const ownerB = testExecutionRegistry();
    const interruptA = vi.fn();
    const interruptB = vi.fn();

    const handleA = testExecutionHandle({
      executionId: 'execution-a',
      parentStreamId: 'parent-a' as StreamTabId,
      childStreamId: 'child-a' as StreamTabId,
      agent: 'codex',
    });
    handleA.attachInterruptHandler({ interrupt: interruptA });
    ownerA.track(handleA);
    const handleB = testExecutionHandle({
      executionId: 'execution-b',
      parentStreamId: 'parent-b' as StreamTabId,
      childStreamId: 'child-b' as StreamTabId,
      agent: 'claude',
    });
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
