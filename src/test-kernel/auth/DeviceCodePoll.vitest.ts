import { describe, expect, it, vi } from 'vitest';

import {
  deviceCodeAuthorized,
  deviceCodePending,
  pollUntilDeviceAuthorized,
} from '@auth/oauth/deviceCodePoll';
import { createFakeClock } from '@test/support/asyncTestUtils';

describe('pollUntilDeviceAuthorized', () => {
  it('returns the authorized value after soft continues', async () => {
    const clock = createFakeClock();
    let attempts = 0;

    const value = await pollUntilDeviceAuthorized({
      intervalMs: 1000,
      deadlineMs: 10_000,
      now: clock.now,
      sleep: clock.sleep,
      createTimeoutError: () => new Error('timed out'),
      attempt: async () => {
        attempts += 1;
        if (attempts < 3) return deviceCodePending();
        return deviceCodeAuthorized('token');
      },
    });

    expect(value).toBe('token');
    expect(attempts).toBe(3);
    expect(clock.sleeps).toEqual([1000, 1000, 1000]);
  });

  it('grows the interval on slow_down deltas', async () => {
    const clock = createFakeClock();
    let attempts = 0;

    await pollUntilDeviceAuthorized({
      intervalMs: 5000,
      deadlineMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      createTimeoutError: () => new Error('timed out'),
      attempt: async () => {
        attempts += 1;
        if (attempts === 1) return deviceCodePending();
        if (attempts === 2) return deviceCodePending(5000);
        return deviceCodeAuthorized(true);
      },
    });

    // 5s, 5s, then 10s after the slow_down bump.
    expect(clock.sleeps).toEqual([5000, 5000, 10000]);
  });

  it('throws the timeout error when the deadline elapses (check before sleep)', async () => {
    const clock = createFakeClock();
    let attempts = 0;

    await expect(
      pollUntilDeviceAuthorized({
        intervalMs: 5000,
        deadlineMs: 10_000,
        now: clock.now,
        sleep: clock.sleep,
        createTimeoutError: () => new Error('deadline passed'),
        attempt: async () => {
          attempts += 1;
          return deviceCodePending();
        },
      }),
    ).rejects.toThrow('deadline passed');

    // t=0 sleep 5 → attempt; t=5 sleep 5 → attempt; t=10 → timeout before sleep.
    expect(attempts).toBe(2);
    expect(clock.sleeps).toEqual([5000, 5000]);
  });

  it('checks the deadline after sleep when checkDeadlineBeforeSleep is false', async () => {
    const clock = createFakeClock();
    let attempts = 0;

    await expect(
      pollUntilDeviceAuthorized({
        intervalMs: 5000,
        deadlineMs: 10_000,
        now: clock.now,
        sleep: clock.sleep,
        checkDeadlineBeforeSleep: false,
        createTimeoutError: () => new Error('expired after wait'),
        attempt: async () => {
          attempts += 1;
          return deviceCodePending();
        },
      }),
    ).rejects.toThrow('expired after wait');

    // sleep 5 → attempt; sleep 5 → t=10 ≥ deadline → timeout (no second attempt).
    expect(attempts).toBe(1);
    expect(clock.sleeps).toEqual([5000, 5000]);
  });

  it('rethrows hard errors from attempt', async () => {
    const clock = createFakeClock();

    await expect(
      pollUntilDeviceAuthorized({
        intervalMs: 1000,
        deadlineMs: 10_000,
        now: clock.now,
        sleep: clock.sleep,
        createTimeoutError: () => new Error('timed out'),
        attempt: async () => {
          throw new Error('access_denied');
        },
      }),
    ).rejects.toThrow('access_denied');
  });

  it('honors AbortSignal before sleeping', async () => {
    const controller = new AbortController();
    controller.abort();
    const attempt = vi.fn();

    await expect(
      pollUntilDeviceAuthorized({
        intervalMs: 1000,
        deadlineMs: Date.now() + 60_000,
        signal: controller.signal,
        createTimeoutError: () => new Error('timed out'),
        attempt,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(attempt).not.toHaveBeenCalled();
  });
});
