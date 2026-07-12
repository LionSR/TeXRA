// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - platform
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
// Local imports - runtime
import { registerAgentShutdownHandlers } from '@agent/runtime/agentShutdown';
import { SessionHandle, defaultSession } from '@agent/runtime/SessionHandle';
// Local imports - CLI session stores
import {
  ClaudeAgentSessions,
  CodexThreads,
} from '@tools/agentCliSessionStores';

describe('agent shutdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drains every live session once and interrupts global CLI sessions', async () => {
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
    const interruptCodex = vi
      .spyOn(CodexThreads, 'interruptAll')
      .mockImplementation(() => {});
    const interruptClaude = vi
      .spyOn(ClaudeAgentSessions, 'interruptAll')
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
