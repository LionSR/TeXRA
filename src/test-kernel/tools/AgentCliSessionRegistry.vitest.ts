// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import type { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import {
  testExecutionHandle,
  testExecutionRegistry,
} from '@test/support/executionHandleFixtures';
import { AgentCliSessionRegistry } from '@tools/agentCliSessionRegistry';

describe('AgentCliSessionRegistry', () => {
  it.effect(
    'atomically claims a session id and wakes waiters when it becomes active',
    () =>
      Effect.gen(function* () {
        const executions = testExecutionRegistry();
        const registry = new AgentCliSessionRegistry(executions);
        const entry = {
          childStreamId: 'child-a' as StreamTabId,
          executionId: 'execution-a' as ExecutionId,
        };

        try {
          const releaseInitialClaim = registry.claim('session-a');
          expect(releaseInitialClaim).toBeTypeOf('function');
          expect(registry.claim('session-a')).toBeUndefined();
          expect(registry.lookup('session-a')).toBeUndefined();

          const waiting = yield* Effect.forkChild(
            registry.waitForActive('session-a'),
          );
          registry.register('session-a', entry);

          expect(yield* Fiber.join(waiting)).toBe(entry);
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
      }),
  );

  it.effect(
    'releases pending waiters and permits a new claim after cleanup',
    () =>
      Effect.gen(function* () {
        const executions = testExecutionRegistry();
        const registry = new AgentCliSessionRegistry(executions);

        try {
          const releaseClaim = registry.claim('session-a');
          expect(releaseClaim).toBeTypeOf('function');
          const waiting = yield* Effect.forkChild(
            registry.waitForActive('session-a'),
          );

          releaseClaim?.();

          expect(yield* Fiber.join(waiting)).toBeUndefined();
          const releaseNextClaim = registry.claim('session-a');
          expect(releaseNextClaim).toBeTypeOf('function');

          releaseNextClaim?.();
          expect(yield* registry.waitForActive('session-a')).toBeUndefined();
        } finally {
          executions.dispose();
        }
      }),
  );

  it('releases every active alias owned by one execution', () => {
    const executions = testExecutionRegistry();
    const registry = new AgentCliSessionRegistry(executions);
    const executionA = 'execution-a' as ExecutionId;
    const executionB = 'execution-b' as ExecutionId;
    const entry = (executionId: ExecutionId, childStreamId: StreamTabId) => ({
      childStreamId,
      executionId,
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
    const executionId = 'execution-in-flight' as ExecutionId;
    const interrupt = vi.fn();
    const registry = new AgentCliSessionRegistry({
      getAgentHandleByStream: () => ({ interrupt }),
    } as unknown as ExecutionRegistry);
    const releaseClaim = registry.claim('reserved-session');

    registry.trackInFlight({
      childStreamId: 'child-in-flight' as StreamTabId,
      executionId,
    });

    expect(registry.lookup('reserved-session')).toBeUndefined();
    registry.interruptAll();
    expect(interrupt).toHaveBeenCalledOnce();

    registry.releaseByExecutionId(executionId);
    registry.interruptAll();
    expect(interrupt).toHaveBeenCalledOnce();
    releaseClaim?.();
  });

  it('interrupts each child through the session execution registry', () => {
    const executions = testExecutionRegistry();
    const registry = new AgentCliSessionRegistry(executions);
    const interruptA = vi.fn();
    const interruptB = vi.fn();

    const handleA = testExecutionHandle({
      executionId: 'execution-a',
      parentStreamId: 'parent-a' as StreamTabId,
      childStreamId: 'child-a' as StreamTabId,
      agent: 'codex',
    });
    handleA.attachInterruptHandler({ interrupt: interruptA });
    executions.track(handleA);
    const handleB = testExecutionHandle({
      executionId: 'execution-b',
      parentStreamId: 'parent-b' as StreamTabId,
      childStreamId: 'child-b' as StreamTabId,
      agent: 'claude',
    });
    handleB.attachInterruptHandler({ interrupt: interruptB });
    executions.track(handleB);

    try {
      registry.claim('pending-session');
      registry.register('session-a', {
        childStreamId: 'child-a' as StreamTabId,
        executionId: 'execution-a' as ExecutionId,
      });
      registry.register('session-b', {
        childStreamId: 'child-b' as StreamTabId,
        executionId: 'execution-b' as ExecutionId,
      });

      registry.interruptAll();

      expect(interruptA).toHaveBeenCalledOnce();
      expect(interruptB).toHaveBeenCalledOnce();
    } finally {
      registry.release('pending-session');
      executions.dispose();
    }
  });
});
