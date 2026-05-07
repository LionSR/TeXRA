// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - test support
import { loadDesktopPlatformModule } from './loadDesktopPlatformModule.mjs';

interface WindowLike {
  isDestroyed(): boolean;
}

interface SecretStorageWarningDialogModule {
  getSecretStorageWarningParentWindow(browserWindow: {
    getAllWindows(): WindowLike[];
    getFocusedWindow(): WindowLike | null;
  }): WindowLike | undefined;
}

describe('desktop secret-storage warning dialog', () => {
  async function loadDialogModule(): Promise<SecretStorageWarningDialogModule> {
    return loadDesktopPlatformModule<SecretStorageWarningDialogModule>(
      'secretStorageWarningDialog.ts',
    );
  }

  it('uses the focused BrowserWindow when one is active', async () => {
    const { getSecretStorageWarningParentWindow } = await loadDialogModule();
    const focusedWindow = { isDestroyed: () => false };
    const otherWindow = { isDestroyed: () => false };

    expect(
      getSecretStorageWarningParentWindow({
        getFocusedWindow: () => focusedWindow,
        getAllWindows: () => [otherWindow],
      }),
    ).toBe(focusedWindow);
  });

  it('falls back to an existing non-destroyed BrowserWindow', async () => {
    const { getSecretStorageWarningParentWindow } = await loadDialogModule();
    const destroyedWindow = { isDestroyed: () => true };
    const liveWindow = { isDestroyed: () => false };

    expect(
      getSecretStorageWarningParentWindow({
        getFocusedWindow: () => null,
        getAllWindows: () => [destroyedWindow, liveWindow],
      }),
    ).toBe(liveWindow);
  });

  it('preserves app-level warning fallback before any window exists', async () => {
    const { getSecretStorageWarningParentWindow } = await loadDialogModule();

    expect(
      getSecretStorageWarningParentWindow({
        getFocusedWindow: () => null,
        getAllWindows: () => [],
      }),
    ).toBeUndefined();
  });
});
