/**
 * Shared RFC 8628 device-authorization poll loop skeleton.
 *
 * Providers own token exchange, error types, and soft-vs-hard failure policy.
 * This only owns sleep, deadline, optional interval growth, and the continue
 * decision after each attempt.
 */
// Node imports
import { setTimeout as defaultSleep } from 'node:timers/promises';

/** Soft continue: keep polling; optionally grow the interval (slow_down). */
export type DeviceCodePollPending = {
  readonly ok: false;
  /** Extra milliseconds to add to the poll interval (RFC 8628 slow_down). */
  readonly intervalDeltaMs?: number;
};

/** Authorized: stop polling and return the value. */
export type DeviceCodePollAuthorized<T> = {
  readonly ok: true;
  readonly value: T;
};

export type DeviceCodePollAttemptResult<T> =
  DeviceCodePollAuthorized<T> | DeviceCodePollPending;

/** Mark a poll attempt as authorized (fixes generic inference at call sites). */
export function deviceCodeAuthorized<T>(value: T): DeviceCodePollAuthorized<T> {
  return { ok: true, value };
}

/**
 * Mark a poll attempt as still pending. Pass `intervalDeltaMs` for RFC 8628
 * `slow_down` (extra milliseconds added to the next wait).
 */
export function deviceCodePending(
  intervalDeltaMs?: number,
): DeviceCodePollPending {
  return intervalDeltaMs === undefined
    ? { ok: false }
    : { ok: false, intervalDeltaMs };
}

export interface DeviceCodePollOptions<T> {
  /** Initial poll interval in milliseconds. */
  readonly intervalMs: number;
  /** Absolute deadline (epoch ms). */
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  /** Called once per poll attempt, after the wait and before the attempt. */
  readonly onPoll?: () => void;
  /**
   * Injectable sleep (tests). Defaults to `node:timers/promises` setTimeout
   * with optional AbortSignal support.
   */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable clock (tests). Defaults to Date.now. */
  readonly now?: () => number;
  /**
   * One token-poll attempt. Return {@link deviceCodeAuthorized} when done, or
   * {@link deviceCodePending} for soft continues (authorization_pending,
   * slow_down, transient). Hard failures must throw.
   */
  readonly attempt: () => Promise<DeviceCodePollAttemptResult<T>>;
  /** Factory for the error thrown when the deadline elapses. */
  readonly createTimeoutError: () => Error;
  /**
   * When true (default), check the deadline before each sleep (Codex / xAI).
   * When false, sleep first then check the deadline before attempting
   * (Supabase CLI device auth — preserves its historical timing).
   */
  readonly checkDeadlineBeforeSleep?: boolean;
}

/**
 * Poll until {@link DeviceCodePollOptions.attempt} authorizes, the deadline
 * elapses, the signal aborts, or a hard error is thrown.
 */
export async function pollUntilDeviceAuthorized<T>(
  options: DeviceCodePollOptions<T>,
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      defaultSleep(ms, undefined, { signal }));
  const checkBefore = options.checkDeadlineBeforeSleep ?? true;
  let intervalMs = options.intervalMs;

  for (;;) {
    options.signal?.throwIfAborted();

    if (checkBefore && now() >= options.deadlineMs) {
      throw options.createTimeoutError();
    }

    await sleep(intervalMs, options.signal);
    options.signal?.throwIfAborted();

    if (!checkBefore && now() >= options.deadlineMs) {
      throw options.createTimeoutError();
    }

    options.onPoll?.();

    const outcome = await options.attempt();
    if (outcome.ok) {
      return outcome.value;
    }
    if (outcome.intervalDeltaMs != null && outcome.intervalDeltaMs > 0) {
      intervalMs += outcome.intervalDeltaMs;
    }
  }
}
