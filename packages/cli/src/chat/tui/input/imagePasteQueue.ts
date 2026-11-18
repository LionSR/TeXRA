// The clipboard image pastes of one input bar in flight, and the submit that
// waits for them: a `FiberSet` of pastes and a `FiberHandle` for the waiting
// submit, both in the scope the bar's mount owns, so unmounting interrupts them.

// Third-party imports
import { Effect, Fiber, FiberHandle, FiberSet } from 'effect';
import { useState } from 'react';

// Local imports
import type { ProcessServices } from '@texra-ai/harness/host';
import type { ScopeRunner } from '../../scopeRunner';

export interface ImagePastes {
  readonly hasPending: () => boolean;
  readonly hasDeferredAction: () => boolean;
  /** Run one paste among the pending ones. */
  readonly add: (paste: Effect.Effect<void, never, ProcessServices>) => void;
  /** Run `action` now, or once the pending pastes land. */
  readonly runWhenIdle: (action: () => void) => void;
  /** Run `action` once the pending pastes land; false when none is pending.
   *  The first submit wins while a paste is pending. */
  readonly deferUntilIdle: (action: () => void) => boolean;
  readonly cancelDeferredAction: () => void;
  /** Interrupt all work that belongs to a discarded draft. */
  readonly discardPending: () => void;
}

/** An input with no clipboard probe has no pastes. */
export const NO_IMAGE_PASTES: ImagePastes = Object.freeze({
  hasPending: () => false,
  hasDeferredAction: () => false,
  add: () => undefined,
  runWhenIdle: (action: () => void) => action(),
  deferUntilIdle: () => false,
  cancelDeferredAction: () => undefined,
  discardPending: () => undefined,
});

export function useImagePastes(mount: ScopeRunner): ImagePastes {
  const [pastes] = useState((): ImagePastes => {
    const { inFlight, waiting } = mount.sync(
      Effect.all({
        inFlight: FiberSet.make<void>(),
        waiting: FiberHandle.make<void>(),
      }),
    );
    const hasPending = (): boolean => [...inFlight].length > 0;
    const hasDeferredAction = (): boolean =>
      waiting.state._tag === 'Open' && waiting.state.fiber !== undefined;
    const deferUntilIdle = (action: () => void): boolean => {
      if (!hasPending()) return false;
      if (hasDeferredAction()) return true;
      // The handle holds only the wait, so the action (which may discard the
      // draft and clear the handle) runs after the handle let its fiber go.
      const wait = mount.sync(
        FiberHandle.run(waiting, FiberSet.awaitEmpty(inFlight)),
      );
      mount.fork(Fiber.join(wait).pipe(Effect.andThen(Effect.sync(action))));
      return true;
    };
    return {
      hasPending,
      hasDeferredAction,
      add: (paste) => {
        mount.sync(FiberSet.run(inFlight, paste));
      },
      runWhenIdle: (action) => {
        if (!deferUntilIdle(action)) action();
      },
      deferUntilIdle,
      cancelDeferredAction: () => {
        mount.sync(FiberHandle.clear(waiting));
      },
      discardPending: () => {
        // The waiting submit first: emptying the pastes would release it.
        mount.sync(
          Effect.andThen(FiberHandle.clear(waiting), FiberSet.clear(inFlight)),
        );
      },
    };
  });
  return pastes;
}
