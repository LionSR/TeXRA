// Test composition imports

// Third-party imports
import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports

import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { createTestSession } from '@test/support/sessionTestUtils';
import {
  claudeAgentSessionsFor,
  codexThreadsFor,
  registerRuntimeShutdownHandlers,
} from '@tools/agentCliSessionStores';

describe('agent shutdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drains every live session once and interrupts its agent-CLI sessions', async () => {
    const firstSession = createTestSession();
    const secondSession = createTestSession();
    const compatibilitySession = testDefaultSession();
    const firstDrain = vi.spyOn(firstSession.runs, 'killBackgroundProcesses');
    const secondDrain = vi.spyOn(secondSession.runs, 'killBackgroundProcesses');
    const compatibilityDrain = vi.spyOn(
      compatibilitySession.runs,
      'killBackgroundProcesses',
    );
    // Session-keyed registries: only sessions whose registry exists are swept.
    const interruptCodex = vi
      .spyOn(codexThreadsFor(firstSession.runs), 'interruptAll')
      .mockImplementation(() => {});
    const interruptClaude = vi
      .spyOn(claudeAgentSessionsFor(secondSession.runs), 'interruptAll')
      .mockImplementation(() => {});

    try {
      const lifecycle = createLifecycleHost();
      registerRuntimeShutdownHandlers(lifecycle, {
        runSettlement: (settlement) => Effect.runPromise(settlement),
        flushArtifacts: () => {},
      });

      await Promise.all([lifecycle.runShutdown(), lifecycle.runShutdown()]);
      await lifecycle.runShutdown();

      expect(firstDrain).toHaveBeenCalledOnce();
      expect(secondDrain).toHaveBeenCalledOnce();
      expect(compatibilityDrain).toHaveBeenCalledOnce();
      expect(interruptCodex).toHaveBeenCalledOnce();
      expect(interruptClaude).toHaveBeenCalledOnce();
    } finally {
      await Effect.runPromise(firstSession.dispose());
      await Effect.runPromise(secondSession.dispose());
    }
  });

  it('preserves the shared shutdown order around host hooks', async () => {
    const session = createTestSession();
    const order: string[] = [];
    vi.spyOn(session.runs, 'killBackgroundProcesses').mockImplementation(() => {
      order.push('agent-shutdown');
    });

    try {
      const lifecycle = createLifecycleHost();
      registerRuntimeShutdownHandlers(lifecycle, {
        runSettlement: (settlement) => Effect.runPromise(settlement),
        beforeAgentShutdown: [() => void order.push('before-agent')],
        afterAgentShutdown: [() => void order.push('after-agent')],
        flushArtifacts: () => void order.push('flush'),
        afterFlushArtifacts: [() => void order.push('after-flush')],
        afterRunSettlement: [() => void order.push('after-settle')],
      });

      await lifecycle.runShutdown();

      expect(order).toEqual([
        'before-agent',
        'agent-shutdown',
        'after-agent',
        'flush',
        'after-flush',
        'after-settle',
      ]);
    } finally {
      await Effect.runPromise(session.dispose());
    }
  });
});
