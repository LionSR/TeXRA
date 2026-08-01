// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';

describe('createLifecycleHost registrations', () => {
  it('keeps duplicate registrations of one callback independent', async () => {
    const lifecycle = createLifecycleHost();
    const callback = vi.fn();

    const first = lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, callback);
    lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, callback);

    first.dispose();
    await lifecycle.runShutdown();

    expect(callback).toHaveBeenCalledOnce();
  });

  it('ignores a repeated dispose instead of dropping another registration', async () => {
    const lifecycle = createLifecycleHost();
    const callback = vi.fn();

    const first = lifecycle.onShutdown(SHUTDOWN_PHASE.ON, callback);
    lifecycle.onShutdown(SHUTDOWN_PHASE.ON, callback);

    first.dispose();
    first.dispose();
    await lifecycle.runShutdown();

    expect(callback).toHaveBeenCalledOnce();
  });
});
