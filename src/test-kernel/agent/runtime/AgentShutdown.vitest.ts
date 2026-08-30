// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { defaultSession } from '@agent/runtime/SessionHandle';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
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
    const compatibilitySession = defaultSession();
    const firstDrain = vi.spyOn(
      firstSession.executions,
      'killBackgroundProcesses',
    );
    const secondDrain = vi.spyOn(
      secondSession.executions,
      'killBackgroundProcesses',
    );
    const compatibilityDrain = vi.spyOn(
      compatibilitySession.executions,
      'killBackgroundProcesses',
    );
    // Session-keyed registries: only sessions whose registry exists are swept.
    const interruptCodex = vi
      .spyOn(codexThreadsFor(firstSession), 'interruptAll')
      .mockImplementation(() => {});
    const interruptClaude = vi
      .spyOn(claudeAgentSessionsFor(secondSession), 'interruptAll')
      .mockImplementation(() => {});

    try {
      const lifecycle = createLifecycleHost();
      registerRuntimeShutdownHandlers(lifecycle, {
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
      firstSession.dispose();
      secondSession.dispose();
    }
  });

  it('preserves the shared shutdown order around host hooks', async () => {
    const session = createTestSession();
    const order: string[] = [];
    vi.spyOn(session.executions, 'killBackgroundProcesses').mockImplementation(
      () => {
        order.push('agent-shutdown');
      },
    );

    try {
      const lifecycle = createLifecycleHost();
      registerRuntimeShutdownHandlers(lifecycle, {
        beforeAgentShutdown: [() => void order.push('before-agent')],
        afterAgentShutdown: [() => void order.push('after-agent')],
        flushArtifacts: () => void order.push('flush'),
        afterFlushArtifacts: [() => void order.push('after-flush')],
        afterExecutionSettlement: [() => void order.push('after-settle')],
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
      session.dispose();
    }
  });
});
