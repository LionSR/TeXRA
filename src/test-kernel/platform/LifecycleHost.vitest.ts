// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, vi } from 'vitest';

// Local imports
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import {
  createLifecycleHost,
  SHUTDOWN_PHASE_DEADLINE_MS,
} from '@platform/defaults/lifecycleHost';

describe('createLifecycleHost registrations', () => {
  it.effect.each([
    // Disposing one of two registrations must leave the other live.
    { phase: SHUTDOWN_PHASE.BEFORE, disposes: 1 },
    // A repeated dispose must not drop the surviving registration either.
    { phase: SHUTDOWN_PHASE.ON, disposes: 2 },
  ])(
    'keeps duplicate registrations of one handler independent ($phase, disposed $disposes time(s))',
    ({ phase, disposes }) =>
      Effect.gen(function* () {
        const lifecycle = createLifecycleHost();
        const ran = vi.fn();
        const handler = Effect.sync(ran);

        const first = lifecycle.onShutdown(phase, handler);
        lifecycle.onShutdown(phase, handler);

        for (let i = 0; i < disposes; i++) {
          first.dispose();
        }
        yield* lifecycle.runShutdown;

        expect(ran).toHaveBeenCalledOnce();
      }),
  );

  // Join-with-deadline (moved from ExecuteCli.vitest.ts's pre-checkpoint
  // shutdown bound): a handler that never settles is interrupted at the phase
  // deadline, reported as a laggard, and the drain advances past it.
  it.effect(
    'interrupts and advances past a handler that misses the phase deadline',
    () =>
      Effect.gen(function* () {
        const onError = vi.fn();
        const lifecycle = createLifecycleHost({ onError });
        const interrupted = vi.fn();
        lifecycle.onShutdown(
          SHUTDOWN_PHASE.BEFORE,
          Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(interrupted))),
        );
        const onPhase = vi.fn();
        lifecycle.onShutdown(SHUTDOWN_PHASE.ON, Effect.sync(onPhase));

        const drain = yield* Effect.forkChild(lifecycle.runShutdown);
        yield* TestClock.adjust(`${SHUTDOWN_PHASE_DEADLINE_MS} millis`);
        yield* Fiber.join(drain);

        expect(interrupted).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledExactlyOnceWith(
          SHUTDOWN_PHASE.BEFORE,
          expect.objectContaining({
            message: expect.stringContaining('settle'),
          }),
        );
        expect(onPhase).toHaveBeenCalledOnce();
      }),
  );
});
