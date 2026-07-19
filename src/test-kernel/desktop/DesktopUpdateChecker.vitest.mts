import { describe, expect, it } from 'vitest';

import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopLatestRelease {
  version: string;
}

interface DesktopUpdateCheckerModule {
  DESKTOP_RELEASES_PAGE_URL: string;
  checkForDesktopUpdate(options: {
    currentVersion: string;
    globalState: FakeStateStore;
    isPackaged: boolean;
    notify: (release: DesktopLatestRelease) => Promise<void> | void;
    now?: () => number;
    fetchRelease?: () => Promise<DesktopLatestRelease | undefined>;
    env?: NodeJS.ProcessEnv;
  }): Promise<void>;
}

async function loadDesktopUpdateChecker(): Promise<DesktopUpdateCheckerModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopUpdateChecker.ts'))
  ) as Promise<DesktopUpdateCheckerModule>;
}

describe('desktop update checker', () => {
  it('exposes a known-constant releases page URL (never opens API-provided URLs)', async () => {
    const { DESKTOP_RELEASES_PAGE_URL } = await loadDesktopUpdateChecker();

    expect(DESKTOP_RELEASES_PAGE_URL).toBe(
      'https://github.com/texra-ai/texra-desktop-releases/releases',
    );
  });

  describe('checkForDesktopUpdate', () => {
    const release: DesktopLatestRelease = {
      version: '0.40.0',
    };

    it('skips entirely for unpackaged (dev) runs', async () => {
      const { checkForDesktopUpdate } = await loadDesktopUpdateChecker();
      const globalState = new FakeStateStore();
      let fetchCalls = 0;
      let notifyCalls = 0;

      await checkForDesktopUpdate({
        currentVersion: '0.39.3',
        globalState,
        isPackaged: false,
        notify: () => {
          notifyCalls += 1;
        },
        fetchRelease: async () => {
          fetchCalls += 1;
          return release;
        },
      });

      expect(fetchCalls).toBe(0);
      expect(notifyCalls).toBe(0);
    });

    it('skips entirely when TEXRA_NO_UPDATE_CHECK is set', async () => {
      const { checkForDesktopUpdate } = await loadDesktopUpdateChecker();
      const globalState = new FakeStateStore();
      let fetchCalls = 0;

      await checkForDesktopUpdate({
        currentVersion: '0.39.3',
        globalState,
        isPackaged: true,
        env: { TEXRA_NO_UPDATE_CHECK: '1' },
        notify: () => {},
        fetchRelease: async () => {
          fetchCalls += 1;
          return release;
        },
      });

      expect(fetchCalls).toBe(0);
    });

    it('notifies once when a newer release is found, and persists the notified version', async () => {
      const { checkForDesktopUpdate } = await loadDesktopUpdateChecker();
      const globalState = new FakeStateStore();
      const notified: DesktopLatestRelease[] = [];

      await checkForDesktopUpdate({
        currentVersion: '0.39.3',
        globalState,
        isPackaged: true,
        env: {},
        notify: (r) => {
          notified.push(r);
        },
        fetchRelease: async () => release,
      });

      expect(notified).toEqual([release]);
      expect(
        globalState.get(
          GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_NOTIFIED_VERSION,
        ),
      ).toBe('0.40.0');
    });

    it('does not notify when the latest release is not newer', async () => {
      const { checkForDesktopUpdate } = await loadDesktopUpdateChecker();
      const globalState = new FakeStateStore();
      let notifyCalls = 0;

      await checkForDesktopUpdate({
        currentVersion: '0.40.0',
        globalState,
        isPackaged: true,
        env: {},
        notify: () => {
          notifyCalls += 1;
        },
        fetchRelease: async () => release,
      });

      expect(notifyCalls).toBe(0);
    });

    it('throttles repeated checks within the same day', async () => {
      const { checkForDesktopUpdate } = await loadDesktopUpdateChecker();
      const globalState = new FakeStateStore();
      let fetchCalls = 0;
      // A realistic epoch timestamp: on the very first check ever,
      // `lastCheckedAt` defaults to 0, and this must be far enough past that
      // default to *not* be throttled (matching a real first launch).
      let nowMs = Date.UTC(2026, 0, 1);

      const run = () =>
        checkForDesktopUpdate({
          currentVersion: '0.39.3',
          globalState,
          isPackaged: true,
          env: {},
          notify: () => {},
          now: () => nowMs,
          fetchRelease: async () => {
            fetchCalls += 1;
            return release;
          },
        });

      await run();
      expect(fetchCalls).toBe(1);

      // Same process, ten minutes later: still throttled.
      nowMs += 10 * 60 * 1000;
      await run();
      expect(fetchCalls).toBe(1);

      // A full day later: throttle window has elapsed.
      nowMs += 24 * 60 * 60 * 1000;
      await run();
      expect(fetchCalls).toBe(2);
    });

    it('does not re-notify for a release version already notified', async () => {
      const { checkForDesktopUpdate } = await loadDesktopUpdateChecker();
      const globalState = new FakeStateStore();
      let notifyCalls = 0;
      let nowMs = Date.UTC(2026, 0, 1);

      const run = () =>
        checkForDesktopUpdate({
          currentVersion: '0.39.3',
          globalState,
          isPackaged: true,
          env: {},
          notify: () => {
            notifyCalls += 1;
          },
          now: () => nowMs,
          fetchRelease: async () => release,
        });

      await run();
      expect(notifyCalls).toBe(1);

      // Next day, same latest release: throttle window elapsed so it fetches
      // again, but must not re-notify for a version already announced.
      nowMs += 24 * 60 * 60 * 1000;
      await run();
      expect(notifyCalls).toBe(1);
    });

    it('does not persist the throttle stamp on a failed fetch, so the next launch retries', async () => {
      const { checkForDesktopUpdate } = await loadDesktopUpdateChecker();
      const globalState = new FakeStateStore();
      let fetchCalls = 0;
      const nowMs = Date.UTC(2026, 0, 1);

      await checkForDesktopUpdate({
        currentVersion: '0.39.3',
        globalState,
        isPackaged: true,
        env: {},
        notify: () => {},
        now: () => nowMs,
        fetchRelease: async () => {
          fetchCalls += 1;
          return undefined; // simulates a network/API failure
        },
      });

      expect(fetchCalls).toBe(1);
      expect(
        globalState.get(GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_CHECKED_AT),
      ).toBeUndefined();

      // Immediately "relaunching" (same day) must retry rather than being
      // throttled for a full 24h off the back of the earlier failure.
      await checkForDesktopUpdate({
        currentVersion: '0.39.3',
        globalState,
        isPackaged: true,
        env: {},
        notify: () => {},
        now: () => nowMs + 1000,
        fetchRelease: async () => {
          fetchCalls += 1;
          return release;
        },
      });

      expect(fetchCalls).toBe(2);
      expect(
        globalState.get(GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_CHECKED_AT),
      ).toBe(nowMs + 1000);
    });

    it('does not persist the throttle stamp when notification fails', async () => {
      const { checkForDesktopUpdate } = await loadDesktopUpdateChecker();
      const globalState = new FakeStateStore();
      const nowMs = Date.UTC(2026, 0, 1);
      let notifyCalls = 0;

      const run = (notify: () => void | Promise<void>) =>
        checkForDesktopUpdate({
          currentVersion: '0.39.3',
          globalState,
          isPackaged: true,
          env: {},
          notify,
          now: () => nowMs,
          fetchRelease: async () => release,
        });

      await expect(
        run(() => {
          notifyCalls += 1;
          throw new Error('dialog failed');
        }),
      ).rejects.toThrow('dialog failed');
      expect(
        globalState.get(GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_CHECKED_AT),
      ).toBeUndefined();

      await run(() => {
        notifyCalls += 1;
      });
      expect(notifyCalls).toBe(2);
      expect(
        globalState.get(GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_CHECKED_AT),
      ).toBe(nowMs);
    });

    it('coalesces concurrent checks into one fetch and notification', async () => {
      const { checkForDesktopUpdate } = await loadDesktopUpdateChecker();
      const globalState = new FakeStateStore();
      let fetchCalls = 0;
      let firstNotifyCalls = 0;
      let secondNotifyCalls = 0;
      let resolveFetch: ((value: DesktopLatestRelease) => void) | undefined;
      const pendingRelease = new Promise<DesktopLatestRelease>((resolve) => {
        resolveFetch = resolve;
      });
      const options = {
        currentVersion: '0.39.3',
        globalState,
        isPackaged: true,
        env: {},
        notify: () => {
          firstNotifyCalls += 1;
        },
        fetchRelease: async () => {
          fetchCalls += 1;
          return pendingRelease;
        },
      };

      const first = checkForDesktopUpdate(options);
      const second = checkForDesktopUpdate({
        ...options,
        notify: () => {
          secondNotifyCalls += 1;
        },
      });
      expect(fetchCalls).toBe(1);

      resolveFetch?.(release);
      await Promise.all([first, second]);
      expect(fetchCalls).toBe(1);
      expect(firstNotifyCalls).toBe(0);
      expect(secondNotifyCalls).toBe(1);
    });
  });
});
