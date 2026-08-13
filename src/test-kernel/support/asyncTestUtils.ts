/**
 * Shared async polling utilities for test suites.
 */

import { setImmediate, setTimeout as sleep } from 'node:timers/promises';

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

/** Poll until a recorded event with the given name appears, or throw after 10 attempts. */
export async function waitForRecordedEvent<TEvent extends string>(
  events: { event: TEvent; payload: unknown }[],
  eventName: TEvent,
): Promise<{ event: TEvent; payload: any }> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const event = events.find((entry) => entry.event === eventName);
    if (event) return event;
    await setImmediate();
  }
  throw new Error(`Timed out waiting for ${eventName}`);
}

/** Create a promise together with the resolver that settles it, for tests that need to control timing externally. */
export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
