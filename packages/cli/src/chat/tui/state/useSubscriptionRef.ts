// The one bridge from an Effect `SubscriptionRef` to a React component: the
// render reads the ref's current value, and its change stream, run on the
// chat's runtime for as long as the component is subscribed, schedules the
// next render. Unsubscribing interrupts that fiber.

// Third-party imports
import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';
import { useCallback, useSyncExternalStore } from 'react';

// Local imports
import type { ProcessRuntime } from '@texra-ai/harness/host';

export function useSubscriptionRef<A>(
  runtime: ProcessRuntime,
  ref: SubscriptionRef.SubscriptionRef<A>,
): A {
  const subscribe = useCallback(
    (notify: () => void) => {
      const fiber = runtime.runFork(
        Stream.runForEach(SubscriptionRef.changes(ref), () =>
          Effect.sync(notify),
        ),
      );
      return () => {
        runtime.runFork(Fiber.interrupt(fiber));
      };
    },
    [runtime, ref],
  );
  return useSyncExternalStore(subscribe, () => SubscriptionRef.getUnsafe(ref));
}
