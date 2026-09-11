// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import type { RunRegistry } from '@agent/runtime/runRegistry';
import type { RunId, RunId } from '@shared/schemas';
import {
  testRunHandle,
  testRunRegistry,
} from '@test/support/runHandleFixtures';
import { AgentCliSessionRegistry } from '@tools/agentCliSessionRegistry';

describe('AgentCliSessionRegistry', () => {
  it.effect(
    'atomically claims a session id and wakes waiters when it becomes active',
    () =>
      Effect.gen(function* () {
        const runs = testRunRegistry();
        const registry = new AgentCliSessionRegistry(runs);
        const entry = {
          childStreamId: 'child-a' as RunId,
          runId: 'run-a' as RunId,
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
          runs.dispose();
        }
      }),
  );

  it.effect(
    'releases pending waiters and permits a new claim after cleanup',
    () =>
      Effect.gen(function* () {
        const runs = testRunRegistry();
        const registry = new AgentCliSessionRegistry(runs);

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
          runs.dispose();
        }
      }),
  );

  it('releases every active alias owned by one run', () => {
    const runs = testRunRegistry();
    const registry = new AgentCliSessionRegistry(runs);
    const runA = 'run-a' as RunId;
    const runB = 'run-b' as RunId;
    const entry = (runId: RunId, childStreamId: RunId) => ({
      childStreamId,
      runId,
    });
    const releasePending = registry.claim('pending-session');

    try {
      registry.register('session-a', entry(runA, 'child-a' as RunId));
      registry.register('session-a-alias', entry(runA, 'child-a' as RunId));
      registry.register('session-b', entry(runB, 'child-b' as RunId));

      registry.releaseByRunId(runA);

      expect(registry.lookup('session-a')).toBeUndefined();
      expect(registry.lookup('session-a-alias')).toBeUndefined();
      expect(registry.lookup('session-b')?.runId).toBe(runB);
      expect(registry.claim('pending-session')).toBeUndefined();
    } finally {
      releasePending?.();
      registry.releaseByRunId(runB);
      runs.dispose();
    }
  });

  it('interrupts an in-flight loop without promoting its reserved resume id', () => {
    const runId = 'run-in-flight' as RunId;
    const interrupt = vi.fn();
    const registry = new AgentCliSessionRegistry({
      getAgentHandleByStream: () => ({ interrupt }),
    } as unknown as RunRegistry);
    const releaseClaim = registry.claim('reserved-session');

    registry.trackInFlight({
      childStreamId: 'child-in-flight' as RunId,
      runId,
    });

    expect(registry.lookup('reserved-session')).toBeUndefined();
    registry.interruptAll();
    expect(interrupt).toHaveBeenCalledOnce();

    registry.releaseByRunId(runId);
    registry.interruptAll();
    expect(interrupt).toHaveBeenCalledOnce();
    releaseClaim?.();
  });

  it('interrupts each child through the session run registry', () => {
    const runs = testRunRegistry();
    const registry = new AgentCliSessionRegistry(runs);
    const interruptA = vi.fn();
    const interruptB = vi.fn();

    const handleA = testRunHandle({
      runId: 'run-a',
      parentStreamId: 'parent-a' as RunId,
      childStreamId: 'child-a' as RunId,
      agent: 'codex',
    });
    handleA.attachInterruptHandler({ interrupt: interruptA });
    runs.track(handleA);
    const handleB = testRunHandle({
      runId: 'run-b',
      parentStreamId: 'parent-b' as RunId,
      childStreamId: 'child-b' as RunId,
      agent: 'claude',
    });
    handleB.attachInterruptHandler({ interrupt: interruptB });
    runs.track(handleB);

    try {
      registry.claim('pending-session');
      registry.register('session-a', {
        childStreamId: 'child-a' as RunId,
        runId: 'run-a' as RunId,
      });
      registry.register('session-b', {
        childStreamId: 'child-b' as RunId,
        runId: 'run-b' as RunId,
      });

      registry.interruptAll();

      expect(interruptA).toHaveBeenCalledOnce();
      expect(interruptB).toHaveBeenCalledOnce();
    } finally {
      registry.release('pending-session');
      runs.dispose();
    }
  });
});
