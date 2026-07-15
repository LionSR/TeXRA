// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - TUI input policy
import { triggerAppCtrlC } from '@cli/chat/tui/appInteractionPolicy';
import { createActiveDraftRegistry } from '@cli/chat/tui/input/activeDraft';

describe('active foreground draft', () => {
  it('discards the most recently registered input draft', () => {
    const registry = createActiveDraftRegistry();
    const background = vi.fn(() => true);
    const foreground = vi.fn(() => true);

    registry.register(background);
    registry.register(foreground);

    expect(registry.discard()).toBe(true);
    expect(foreground).toHaveBeenCalledOnce();
    expect(background).not.toHaveBeenCalled();
  });

  it('restores the previous input when the foreground input unmounts', () => {
    const registry = createActiveDraftRegistry();
    const background = vi.fn(() => true);
    const foreground = vi.fn(() => true);
    registry.register(background);
    const unregisterForeground = registry.register(foreground);

    unregisterForeground();

    expect(registry.discard()).toBe(true);
    expect(background).toHaveBeenCalledOnce();
    expect(foreground).not.toHaveBeenCalled();
  });

  it('reports an empty registry without consuming Ctrl-C', () => {
    const registry = createActiveDraftRegistry();

    expect(registry.discard()).toBe(false);
  });

  it('clears a dialog draft before the root policy exits', () => {
    const registry = createActiveDraftRegistry();
    const onExit = vi.fn();
    let draft = 'answer in progress';
    registry.register(() => {
      if (draft.length === 0) return false;
      draft = '';
      return true;
    });

    expect(
      triggerAppCtrlC({
        discardDraft: registry.discard,
        canStopActiveRun: () => false,
        onInterruptActive: vi.fn(),
        onExit,
      }),
    ).toBe('clear-draft');
    expect(draft).toBe('');
    expect(onExit).not.toHaveBeenCalled();
  });
});
