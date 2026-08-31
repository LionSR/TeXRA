import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';

import { loadSourceModule } from './loadSourceModule.ts';

type DesktopUpdateCheckerModule =
  typeof import('@desktop/main/desktopUpdateChecker');
type CheckForDesktopUpdateOptions = Parameters<
  DesktopUpdateCheckerModule['checkForDesktopUpdate']
>[0];
type DesktopLatestRelease = Parameters<
  CheckForDesktopUpdateOptions['notify']
>[0];

describe('desktop update checker', () => {
  it('exposes a known-constant releases page URL (never opens API-provided URLs)', async () => {
    const { DESKTOP_RELEASES_PAGE_URL } = await loadSourceModule(
      '@desktop/main/desktopUpdateChecker',
    );

    expect(DESKTOP_RELEASES_PAGE_URL).toBe(
      'https://github.com/texra-ai/texra-desktop-releases/releases',
    );
  });

  describe('checkForDesktopUpdate', () => {
    const release: DesktopLatestRelease = {
      version: '0.40.0',
    };
    const CURRENT_VERSION = '0.39.3';
    let checkForDesktopUpdate: DesktopUpdateCheckerModule['checkForDesktopUpdate'];
    let globalState: FakeStateStore;

    beforeEach(async () => {
      ({ checkForDesktopUpdate } = await loadSourceModule(
        '@desktop/main/desktopUpdateChecker',
      ));
      globalState = new FakeStateStore();
    });

    /** One check with the packaged, update-enabled defaults these cases share. */
    function runCheck(
      overrides: Partial<CheckForDesktopUpdateOptions> = {},
    ): Promise<void> {
      return checkForDesktopUpdate({
        currentVersion: CURRENT_VERSION,
        globalState,
        isPackaged: true,
        env: {},
        notify: () => {},
        fetchRelease: async () => release,
        ...overrides,
      });
    }

    it('skips entirely for unpackaged (dev) runs', async () => {
      const notify = vi.fn();
      const fetchRelease = vi.fn(async () => release);

      await runCheck({ isPackaged: false, notify, fetchRelease });

      expect(fetchRelease).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('skips entirely when TEXRA_NO_UPDATE_CHECK is set', async () => {
      const fetchRelease = vi.fn(async () => release);

      await runCheck({ env: { TEXRA_NO_UPDATE_CHECK: '1' }, fetchRelease });

      expect(fetchRelease).not.toHaveBeenCalled();
    });

    // Wiring smoke case: the throttle/no-repeat semantics themselves are
    // owned by SemverUpdateCheck.vitest.ts (runDailyUpdateCheck); this pins
    // that desktop actually wires the once-per-release key through.
    it('notifies once when a newer release is found, and persists the notified version', async () => {
      const notify = vi.fn();

      await runCheck({ notify });

      expect(notify).toHaveBeenCalledExactlyOnceWith(release);
      expect(
        globalState.get(
          GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_NOTIFIED_VERSION,
        ),
      ).toBe('0.40.0');
    });

    it('coalesces concurrent checks into one fetch and notification', async () => {
      let resolveFetch: ((value: DesktopLatestRelease) => void) | undefined;
      const pendingRelease = new Promise<DesktopLatestRelease>((resolve) => {
        resolveFetch = resolve;
      });
      const fetchRelease = vi.fn(() => pendingRelease);
      const firstNotify = vi.fn();
      const secondNotify = vi.fn();

      const first = runCheck({ notify: firstNotify, fetchRelease });
      const second = runCheck({ notify: secondNotify, fetchRelease });
      expect(fetchRelease).toHaveBeenCalledOnce();

      resolveFetch?.(release);
      await Promise.all([first, second]);

      expect(fetchRelease).toHaveBeenCalledOnce();
      expect(firstNotify).not.toHaveBeenCalled();
      expect(secondNotify).toHaveBeenCalledOnce();
    });
  });
});
