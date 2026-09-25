// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { installDesktopUnsavedCloseWiring } from '@desktop/renderer/desktopUnsavedClose';

function createBeforeUnloadWindow() {
  let listener:
    | ((event: { preventDefault(): void; returnValue: string }) => void)
    | undefined;
  return {
    addEventListener: vi.fn((_type, nextListener) => {
      listener = nextListener;
    }),
    dispatch(event: { preventDefault(): void; returnValue: string }) {
      listener?.(event);
    },
  };
}

describe('desktop control system (packages/desktop/src/renderer/desktopUnsavedClose.ts)', () => {
  it('vetoes renderer closes only while the editor has unsaved changes', () => {
    const dirtyWindow = createBeforeUnloadWindow();
    const dirtyEvent = { preventDefault: vi.fn(), returnValue: 'unchanged' };
    installDesktopUnsavedCloseWiring(dirtyWindow, {
      hasUnsavedChanges: () => true,
    });
    dirtyWindow.dispatch(dirtyEvent);
    expect(dirtyEvent.preventDefault).toHaveBeenCalledOnce();
    expect(dirtyEvent.returnValue).toBe('');

    const cleanWindow = createBeforeUnloadWindow();
    const cleanEvent = { preventDefault: vi.fn(), returnValue: 'unchanged' };
    installDesktopUnsavedCloseWiring(cleanWindow, {
      hasUnsavedChanges: () => false,
    });
    cleanWindow.dispatch(cleanEvent);
    expect(cleanEvent.preventDefault).not.toHaveBeenCalled();
    expect(cleanEvent.returnValue).toBe('unchanged');
  });
});
