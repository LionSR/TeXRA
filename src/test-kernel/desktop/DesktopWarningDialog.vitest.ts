// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - test support
import { loadSourceModule } from './loadSourceModule.ts';

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

async function loadDialogModule(): Promise<WarningDialogModule> {
  const module = await loadSourceModule('@desktop/main/platform/warningDialog');
  return module as unknown as WarningDialogModule;
}

const focusedWindow: WindowLike = { isDestroyed: () => false };
const destroyedWindow: WindowLike = { isDestroyed: () => true };
const liveWindow: WindowLike = { isDestroyed: () => false };

describe('desktop warning dialog', () => {
  it.each([
    {
      name: 'uses the focused BrowserWindow when one is active',
      focused: focusedWindow,
      all: [liveWindow],
      expected: focusedWindow,
    },
    {
      name: 'falls back to an existing non-destroyed BrowserWindow',
      focused: null,
      all: [destroyedWindow, liveWindow],
      expected: liveWindow,
    },
    {
      name: 'preserves app-level warning fallback before any window exists',
      focused: null,
      all: [],
      expected: undefined,
    },
  ])('$name', async ({ focused, all, expected }) => {
    const { getDesktopWarningParentWindow } = await loadDialogModule();

    expect(
      getDesktopWarningParentWindow({
        getFocusedWindow: () => focused,
        getAllWindows: () => all,
      }),
    ).toBe(expected);
  });
});
