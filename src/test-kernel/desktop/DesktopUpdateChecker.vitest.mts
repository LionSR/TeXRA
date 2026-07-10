import { describe, expect, it } from 'vitest';

import { GlobalStateKey } from '@shared/state/stateKeys';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

class MemoryStateStore {
  readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
}

interface DesktopLatestRelease {
  version: string;
}

interface DesktopUpdateCheckerModule {
  DESKTOP_RELEASES_PAGE_URL: string;
  isNewerDesktopVersion(latest: string, current: string): boolean;
  checkForDesktopUpdate(options: {
    currentVersion: string;
    globalState: MemoryStateStore;
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
  describe('isNewerDesktopVersion', () => {
    it('is true only when latest strictly outranks current', async () => {
      const { isNewerDesktopVersion } = await loadDesktopUpdateChecker();

      expect(isNewerDesktopVersion('0.40.0', '0.39.3')).toBe(true);
      expect(isNewerDesktopVersion('0.39.3', '0.39.3')).toBe(false);
      expect(isNewerDesktopVersion('0.38.0', '0.39.3')).toBe(false);
    });

    it('treats unparseable versions as not newer', async () => {
      const { isNewerDesktopVersion } = await loadDesktopUpdateChecker();

      expect(isNewerDesktopVersion('not-a-version', '0.39.3')).toBe(false);
      expect(isNewerDesktopVersion('0.40.0', 'not-a-version')).toBe(false);
    });
  });

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
      const globalState = new MemoryStateStore();
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
      const globalState = new MemoryStateStore();
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
      const globalState = new MemoryStateStore();
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
        globalState.values.get(
          GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_NOTIFIED_VERSION,
        ),
      ).toBe('0.40.0');
    });

    it('does not notify when the latest release is not newer', async () => {
      const { checkForDesktopUpdate } = await loadDesktopUpdateChecker();
      const globalState = new MemoryStateStore();
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
      const globalState = new MemoryStateStore();
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
      const globalState = new MemoryStateStore();
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
      const globalState = new MemoryStateStore();
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
        globalState.values.get(
          GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_CHECKED_AT,
        ),
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
        globalState.values.get(
          GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_CHECKED_AT,
        ),
      ).toBe(nowMs + 1000);
    });
  });
});
