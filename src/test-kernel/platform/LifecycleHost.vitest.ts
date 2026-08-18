// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';

describe('createLifecycleHost registrations', () => {
  it.each([
    // Disposing one of two registrations must leave the other live.
    { phase: SHUTDOWN_PHASE.BEFORE, disposes: 1 },
    // A repeated dispose must not drop the surviving registration either.
    { phase: SHUTDOWN_PHASE.ON, disposes: 2 },
  ])(
    'keeps duplicate registrations of one callback independent ($phase, disposed $disposes time(s))',
    async ({ phase, disposes }) => {
      const lifecycle = createLifecycleHost();
      const callback = vi.fn();

      const first = lifecycle.onShutdown(phase, callback);
      lifecycle.onShutdown(phase, callback);

      for (let i = 0; i < disposes; i++) {
        first.dispose();
      }
      await lifecycle.runShutdown();

      expect(callback).toHaveBeenCalledOnce();
    },
  );

  // Join-with-deadline (moved from RunExecution.vitest.ts's pre-checkpoint
  // shutdown bound): a handler that never settles is aborted at the phase
  // deadline, reported as a laggard, and the drain advances past it.
  it('aborts and advances past a handler that misses the phase deadline', async () => {
    const onError = vi.fn();
    const lifecycle = createLifecycleHost({ onError });
    let handlerSignal: AbortSignal | undefined;
    lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, (signal) => {
      handlerSignal = signal;
      return new Promise<void>(() => {});
    });
    const onPhase = vi.fn();
    lifecycle.onShutdown(SHUTDOWN_PHASE.ON, onPhase);

    vi.useFakeTimers();
    try {
      const shutdown = lifecycle.runShutdown();
      await vi.advanceTimersByTimeAsync(5_000);
      // One more tick for the post-abort yield that precedes the advance.
      await vi.advanceTimersByTimeAsync(1);
      await shutdown;
    } finally {
      vi.useRealTimers();
    }

    expect(handlerSignal?.aborted).toBe(true);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      SHUTDOWN_PHASE.BEFORE,
      expect.objectContaining({ message: expect.stringContaining('settle') }),
    );
    expect(onPhase).toHaveBeenCalledOnce();
  });
});
