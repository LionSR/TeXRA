/**
 * Shared async polling utilities for test suites.
 */

import { setTimeout as sleep } from 'node:timers/promises';

interface PollOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

interface WaitForConditionOptions extends PollOptions {
  readonly timeoutMessage?: string;
}

/** Poll until a condition succeeds, or throw when its deadline expires. */
export async function waitForCondition(
  predicate: () => boolean,
  {
    timeoutMs = 2000,
    intervalMs = 10,
    timeoutMessage = 'Timed out waiting for state',
  }: WaitForConditionOptions = {},
): Promise<void> {
  if (await pollForCondition(predicate, { timeoutMs, intervalMs })) return;
  throw new Error(timeoutMessage);
}

/** Poll until a condition succeeds and report whether it met the deadline. */
export async function pollForCondition(
  predicate: () => boolean,
  { timeoutMs = 2000, intervalMs = 10 }: PollOptions = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

/** Create a promise together with the resolvers that settle it, for tests that need to control timing externally. */
export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
