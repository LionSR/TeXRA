// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import type { RunRegistry } from '@agent/runtime/runRegistry';
import type { RunId } from '@shared/schemas';
import {
  admitInterruptibleRun,
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
        const entry = { runId: 'run-a' as RunId };

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
    const entry = (runId: RunId) => ({ runId });
    const releasePending = registry.claim('pending-session');

    try {
      registry.register('session-a', entry(runA));
      registry.register('session-a-alias', entry(runA));
      registry.register('session-b', entry(runB));

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
    const interrupt = vi.fn(() => true);
    const registry = new AgentCliSessionRegistry({
      interrupt,
    } as unknown as RunRegistry);
    const releaseClaim = registry.claim('reserved-session');

    registry.trackInFlight({ runId });

    expect(registry.lookup('reserved-session')).toBeUndefined();
    registry.interruptAll();
    expect(interrupt).toHaveBeenCalledOnce();

    registry.releaseByRunId(runId);
    registry.interruptAll();
    expect(interrupt).toHaveBeenCalledOnce();
    releaseClaim?.();
  });

  it.effect('interrupts each child through the session run registry', () =>
    Effect.gen(function* () {
      const runs = testRunRegistry();
      const registry = new AgentCliSessionRegistry(runs);
      const interruptA = vi.fn();
      const interruptB = vi.fn();

      runs.track(
        testRunHandle({
          runId: 'run-a' as RunId,
          parent: 'parent-a' as RunId,
          agent: 'codex',
        }),
      );
      const fiberA = admitInterruptibleRun(runs, 'run-a' as RunId, interruptA);
      runs.track(
        testRunHandle({
          runId: 'run-b' as RunId,
          parent: 'parent-b' as RunId,
          agent: 'claude',
        }),
      );
      const fiberB = admitInterruptibleRun(runs, 'run-b' as RunId, interruptB);

      try {
        registry.claim('pending-session');
        registry.register('session-a', { runId: 'run-a' as RunId });
        registry.register('session-b', { runId: 'run-b' as RunId });

        registry.interruptAll();
        // The stop lands through each run's generation fiber; the spy has
        // observably landed once that fiber's unwinding completes.
        yield* Fiber.await(fiberA);
        yield* Fiber.await(fiberB);

        expect(interruptA).toHaveBeenCalledOnce();
        expect(interruptB).toHaveBeenCalledOnce();
      } finally {
        registry.release('pending-session');
        runs.dispose();
      }
    }),
  );
});
