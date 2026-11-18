// The one bridge from an Effect `SubscriptionRef` to a React component: the
// render reads the ref's current value, and its change stream, followed on
// the component's mount scope for as long as the component is subscribed,
// schedules the next render. Unsubscribing interrupts that fiber.

// Third-party imports
import { Effect, Stream, SubscriptionRef } from 'effect';
import { useCallback, useSyncExternalStore } from 'react';

// Local imports
import type { ScopeRunner } from '../../scopeRunner';

export function useSubscriptionRef<A>(
  mount: ScopeRunner,
  ref: SubscriptionRef.SubscriptionRef<A>,
): A {
  const subscribe = useCallback(
    (notify: () => void) => {
      const fiber = mount.fork(
        Stream.runForEach(SubscriptionRef.changes(ref), () =>
          Effect.sync(notify),
        ),
      );
      return () => fiber.interruptUnsafe();
    },
    [mount, ref],
  );
  return useSyncExternalStore(subscribe, () => SubscriptionRef.getUnsafe(ref));
}
