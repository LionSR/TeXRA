import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CheckForDesktopUpdateOptions } from '@desktop/main/desktopUpdateChecker';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';

import { loadSourceModule } from './loadSourceModule.ts';

type DesktopUpdateCheckerModule =
  typeof import('@desktop/main/desktopUpdateChecker');
type DesktopLatestRelease = Parameters<
  CheckForDesktopUpdateOptions['notify']
>[0];

describe('desktop update checker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
    const DAY_MS = 24 * 60 * 60 * 1000;
    let checkForDesktopUpdate: DesktopUpdateCheckerModule['checkForDesktopUpdate'];
    let globalState: FakeStateStore;
    let nowMs: number;

    beforeEach(async () => {
      ({ checkForDesktopUpdate } = await loadSourceModule(
        '@desktop/main/desktopUpdateChecker',
      ));
      globalState = new FakeStateStore();
      nowMs = Date.UTC(2026, 0, 1);
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

    function lastCheckedAt(): number | undefined {
      return globalState.get(
        GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_CHECKED_AT,
      );
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

    it('does not notify when the latest release is not newer', async () => {
      const notify = vi.fn();

      await runCheck({ currentVersion: release.version, notify });

      expect(notify).not.toHaveBeenCalled();
    });

    it('throttles repeated checks within the same day', async () => {
      const fetchRelease = vi.fn(async () => release);
      // A realistic epoch timestamp: on the very first check ever,
      // `lastCheckedAt` defaults to 0, and this must be far enough past that
      // default to *not* be throttled (matching a real first launch).
      const run = () => runCheck({ now: () => nowMs, fetchRelease });

      await run();
      expect(fetchRelease).toHaveBeenCalledTimes(1);

      // Same process, ten minutes later: still throttled.
      nowMs += 10 * 60 * 1000;
      await run();
      expect(fetchRelease).toHaveBeenCalledTimes(1);

      // A full day later: throttle window has elapsed.
      nowMs += DAY_MS;
      await run();
      expect(fetchRelease).toHaveBeenCalledTimes(2);
    });

    it('does not re-notify for a release version already notified', async () => {
      const notify = vi.fn();
      const run = () => runCheck({ now: () => nowMs, notify });

      await run();
      expect(notify).toHaveBeenCalledTimes(1);

      // Next day, same latest release: throttle window elapsed so it fetches
      // again, but must not re-notify for a version already announced.
      nowMs += DAY_MS;
      await run();
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('does not persist the throttle stamp on a failed fetch, so the next launch retries', async () => {
      // `undefined` is how a network or API failure reaches the checker.
      const failingFetch = vi.fn(async () => undefined);

      await runCheck({ now: () => nowMs, fetchRelease: failingFetch });

      expect(failingFetch).toHaveBeenCalledOnce();
      expect(lastCheckedAt()).toBeUndefined();

      // Immediately "relaunching" (same day) must retry rather than being
      // throttled for a full 24h off the back of the earlier failure.
      const retriedFetch = vi.fn(async () => release);

      await runCheck({ now: () => nowMs + 1000, fetchRelease: retriedFetch });

      expect(retriedFetch).toHaveBeenCalledOnce();
      expect(lastCheckedAt()).toBe(nowMs + 1000);
    });

    it('treats an empty release tag as a failed fetch', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ tag_name: '' }),
        })) as unknown as typeof fetch,
      );

      // No `fetchRelease`: this drives the real GitHub fetch path.
      await runCheck({ fetchRelease: undefined });

      expect(lastCheckedAt()).toBeUndefined();
    });

    it('does not persist the throttle stamp when notification fails', async () => {
      let dialogFails = true;
      const notify = vi.fn(() => {
        if (dialogFails) throw new Error('dialog failed');
      });

      await expect(runCheck({ now: () => nowMs, notify })).rejects.toThrow(
        'dialog failed',
      );
      expect(lastCheckedAt()).toBeUndefined();

      dialogFails = false;
      await runCheck({ now: () => nowMs, notify });

      expect(notify).toHaveBeenCalledTimes(2);
      expect(lastCheckedAt()).toBe(nowMs);
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
