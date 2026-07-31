// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - test support
import { loadSourceModule } from './loadSourceModule.mjs';

interface WindowLike {
  isDestroyed(): boolean;
}

/**
 * The helper only reads `isDestroyed()`, so the tests drive it with plain
 * stand-ins rather than real `BrowserWindow` instances.
 */
interface WarningDialogModule {
  getDesktopWarningParentWindow(browserWindow: {
    getAllWindows(): WindowLike[];
    getFocusedWindow(): WindowLike | null;
  }): WindowLike | undefined;
}

describe('desktop warning dialog', () => {
  async function loadDialogModule(): Promise<WarningDialogModule> {
    const module = await loadSourceModule(
      '@desktop/main/platform/warningDialog',
    );
    return module as unknown as WarningDialogModule;
  }

  it('uses the focused BrowserWindow when one is active', async () => {
    const { getDesktopWarningParentWindow } = await loadDialogModule();
    const focusedWindow = { isDestroyed: () => false };
    const otherWindow = { isDestroyed: () => false };

    expect(
      getDesktopWarningParentWindow({
        getFocusedWindow: () => focusedWindow,
        getAllWindows: () => [otherWindow],
      }),
    ).toBe(focusedWindow);
  });

  it('falls back to an existing non-destroyed BrowserWindow', async () => {
    const { getDesktopWarningParentWindow } = await loadDialogModule();
    const destroyedWindow = { isDestroyed: () => true };
    const liveWindow = { isDestroyed: () => false };

    expect(
      getDesktopWarningParentWindow({
        getFocusedWindow: () => null,
        getAllWindows: () => [destroyedWindow, liveWindow],
      }),
    ).toBe(liveWindow);
  });

  it('preserves app-level warning fallback before any window exists', async () => {
    const { getDesktopWarningParentWindow } = await loadDialogModule();

    expect(
      getDesktopWarningParentWindow({
        getFocusedWindow: () => null,
        getAllWindows: () => [],
      }),
    ).toBeUndefined();
  });
});
