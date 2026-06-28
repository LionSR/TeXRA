/**
 * Shared async polling utilities for test suites.
 */

/** Poll until a recorded event with the given name appears, or throw after 10 attempts. */
export async function waitForRecordedEvent<TEvent extends string>(
  events: Array<{ event: TEvent; payload: unknown }>,
  eventName: TEvent,
): Promise<{ event: TEvent; payload: any }> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const event = events.find((entry) => entry.event === eventName);
    if (event) return event;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${eventName}`);
}
