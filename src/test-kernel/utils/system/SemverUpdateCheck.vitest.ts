import { describe, expect, it, vi } from 'vitest';

import { FakeStateStore } from '@test/support/FakePlatform';
import { isNewerSemverVersion } from '@utils/system/semverUpdateCheck';
import {
  fetchJsonStringField,
  runDailyUpdateCheck,
} from '@utils/system/updateCheck';

describe('isNewerSemverVersion', () => {
  it('compares numerically across all components', () => {
    expect(isNewerSemverVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerSemverVersion('0.39.0', '0.38.2')).toBe(true);
    expect(isNewerSemverVersion('0.38.3', '0.38.2')).toBe(true);
    expect(isNewerSemverVersion('0.38.2', '0.38.2')).toBe(false);
    expect(isNewerSemverVersion('0.38.1', '0.38.2')).toBe(false);
  });

  it('ranks a release above its prerelease but not vice versa', () => {
    expect(isNewerSemverVersion('1.2.0', '1.2.0-rc.1')).toBe(true);
    expect(isNewerSemverVersion('1.2.0-rc.1', '1.2.0')).toBe(false);
    expect(isNewerSemverVersion('1.2.0-rc.2', '1.2.0-rc.1')).toBe(true);
  });

  it('returns false when either version is unparseable', () => {
    expect(isNewerSemverVersion('1.0.0', 'unknown')).toBe(false);
    expect(isNewerSemverVersion('latest', '1.0.0')).toBe(false);
    expect(isNewerSemverVersion('not-a-version', '0.39.3')).toBe(false);
    expect(isNewerSemverVersion('0.40.0', 'not-a-version')).toBe(false);
  });
});

describe('runDailyUpdateCheck', () => {
  const nowMs = Date.UTC(2026, 0, 1);
  const lastCheckedAtKey = 'update.lastCheckedAt';
  const lastNotifiedVersionKey = 'update.lastNotifiedVersion';

  type CheckOptions = Parameters<typeof runDailyUpdateCheck>[0];

  function checkOptions(
    state: FakeStateStore,
    overrides: Partial<CheckOptions> = {},
  ): CheckOptions {
    return {
      currentVersion: '1.0.0',
      state,
      lastCheckedAtKey,
      fetchLatest: async () => ({ version: '1.0.0', refreshed: true }),
      notify: () => {},
      now: () => nowMs,
      ...overrides,
    };
  }

  it('notifies before stamping a successful live check', async () => {
    const state = new FakeStateStore();
    let stampDuringNotify: number | undefined;

    const latest = await runDailyUpdateCheck(
      checkOptions(state, {
        fetchLatest: async () => ({ version: '1.1.0', refreshed: true }),
        notify: () => {
          stampDuringNotify = state.get(lastCheckedAtKey);
        },
      }),
    );

    expect(latest).toBe('1.1.0');
    expect(stampDuringNotify).toBeUndefined();
    expect(state.get(lastCheckedAtKey)).toBe(nowMs);
  });

  it('does not repeat a release notification but still stamps a live refresh', async () => {
    const state = new FakeStateStore({
      [lastNotifiedVersionKey]: '1.1.0',
    });
    const notify = vi.fn();

    await runDailyUpdateCheck(
      checkOptions(state, {
        lastNotifiedVersionKey,
        fetchLatest: async () => ({ version: '1.1.0', refreshed: true }),
        notify,
      }),
    );

    expect(notify).not.toHaveBeenCalled();
    expect(state.get(lastCheckedAtKey)).toBe(nowMs);
  });

  it('can offer stale source metadata without stamping the check', async () => {
    const state = new FakeStateStore();
    const notify = vi.fn();

    await runDailyUpdateCheck(
      checkOptions(state, {
        fetchLatest: async () => ({ version: '1.1.0', refreshed: false }),
        notify,
      }),
    );

    expect(notify).toHaveBeenCalledWith('1.1.0');
    expect(state.get(lastCheckedAtKey)).toBeUndefined();
  });

  it('applies the host policy when the throttle stamp cannot be persisted', async () => {
    const state = new FakeStateStore();
    vi.spyOn(state, 'update').mockRejectedValue(new Error('read-only state'));
    const options = checkOptions(state);

    await expect(
      runDailyUpdateCheck({ ...options, stampFailure: 'ignore' }),
    ).resolves.toBeUndefined();
    await expect(runDailyUpdateCheck(options)).rejects.toThrow(
      'read-only state',
    );
  });

  it('ignores a synchronous throttle stamp failure when requested', async () => {
    const state = new FakeStateStore();
    vi.spyOn(state, 'update').mockImplementation(() => {
      throw new Error('read-only state');
    });

    await expect(
      runDailyUpdateCheck(checkOptions(state, { stampFailure: 'ignore' })),
    ).resolves.toBeUndefined();
  });
});

describe('fetchJsonStringField', () => {
  it('rejects an empty string field', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ version: '' }),
    ) as unknown as typeof fetch;

    await expect(
      fetchJsonStringField({
        url: 'https://example.test/latest',
        field: 'version',
        timeoutMs: 1000,
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
  });
});
