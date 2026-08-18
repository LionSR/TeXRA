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
  registerAgentShutdownHandlers,
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
      registerAgentShutdownHandlers(lifecycle);

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
});
