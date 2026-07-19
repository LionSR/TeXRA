// Test support imports

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime and tools
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createTestSession } from '@test/support/sessionTestUtils';
import { notifyUnavailableTools } from '@tools/toolUnavailableNotification';

describe('notifyUnavailableTools', () => {
  it('deduplicates tool groups independently for each session', () => {
    const explicitSession = createTestSession();
    const contextualSession = createTestSession();
    const explicitNotification = vi.fn();
    const contextualNotification = vi.fn();
    explicitSession.useHostInteractions({
      notifyUnavailableTools: explicitNotification,
      cancel: vi.fn(),
    });
    contextualSession.useHostInteractions({
      notifyUnavailableTools: contextualNotification,
      cancel: vi.fn(),
    });

    try {
      notifyUnavailableTools(['lean_diagnostics'], explicitSession);
      notifyUnavailableTools(['lean_file'], explicitSession);

      withRunContext(
        createRunContext({
          runtimeHost: { emit: vi.fn() },
          session: contextualSession,
        }),
        () => {
          notifyUnavailableTools(['lean_diagnostics']);
          notifyUnavailableTools(['lean_file']);
        },
      );

      expect(explicitNotification).toHaveBeenCalledOnce();
      expect(contextualNotification).toHaveBeenCalledOnce();
      expect(explicitNotification).toHaveBeenCalledWith(
        expect.stringContaining('"Lean 4 Proof Assistant"'),
        'texra.showTools',
        'Open Tools Dashboard',
      );
      expect(contextualNotification).toHaveBeenCalledWith(
        expect.stringContaining('"Lean 4 Proof Assistant"'),
        'texra.showTools',
        'Open Tools Dashboard',
      );
    } finally {
      explicitSession.dispose();
      contextualSession.dispose();
    }
  });

  it('waits for an adapter and does not repeat after adapter replacement', () => {
    const session = createTestSession();
    const firstNotification = vi.fn();
    const secondNotification = vi.fn();

    try {
      notifyUnavailableTools(['lean_diagnostics'], session);

      const detachFirst = session.useHostInteractions({
        notifyUnavailableTools: firstNotification,
        cancel: vi.fn(),
      });
      notifyUnavailableTools(['lean_diagnostics'], session);
      expect(firstNotification).toHaveBeenCalledOnce();

      detachFirst();
      session.useHostInteractions({
        notifyUnavailableTools: secondNotification,
        cancel: vi.fn(),
      });
      notifyUnavailableTools(['lean_diagnostics'], session);
      expect(secondNotification).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });
});
