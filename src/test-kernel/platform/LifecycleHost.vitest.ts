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
});
