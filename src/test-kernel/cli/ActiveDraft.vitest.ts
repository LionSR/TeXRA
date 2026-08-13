// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - TUI input policy
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
});
