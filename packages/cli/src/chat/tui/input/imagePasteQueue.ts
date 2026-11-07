// The clipboard image pastes of one input bar in flight, and the submit that
// waits for them: a `FiberSet` of pastes and a `FiberHandle` for the waiting
// submit, both in a scope the bar's mount owns, so unmounting interrupts them.

// Third-party imports
import { Cause, Effect, FiberHandle, FiberSet, Scope } from 'effect';
import { useState } from 'react';

// Local imports
import { withLogChannel } from '@texra-ai/harness/host';
import { useMountScope } from '../state/useMountScope';
import type { ProcessRuntime, ProcessServices } from '@texra-ai/harness/host';

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

export function useImagePastes(runtime: ProcessRuntime): ImagePastes {
  const scope = useMountScope(runtime);
  const [pastes] = useState((): ImagePastes => {
    const { inFlight, waiting } = runtime.runSync(
      Effect.all({
        inFlight: FiberSet.make<void>(),
        waiting: FiberHandle.make<void>(),
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    const hasPending = (): boolean => [...inFlight].length > 0;
    const hasDeferredAction = (): boolean =>
      waiting.state._tag === 'Open' && waiting.state.fiber !== undefined;
    const deferUntilIdle = (action: () => void): boolean => {
      if (!hasPending()) return false;
      runtime.runSync(
        FiberHandle.run(
          waiting,
          FiberSet.awaitEmpty(inFlight).pipe(
            Effect.andThen(Effect.sync(action)),
            // The submit runs in a fiber, where a throw would vanish.
            Effect.catchDefect((defect) =>
              Effect.logWarning('The deferred image-paste action failed.').pipe(
                Effect.annotateLogs({ data: Cause.squash(Cause.die(defect)) }),
                withLogChannel('cli.tui'),
              ),
            ),
          ),
          { onlyIfMissing: true },
        ),
      );
      return true;
    };
    return {
      hasPending,
      hasDeferredAction,
      add: (paste) => {
        runtime.runSync(FiberSet.run(inFlight, paste));
      },
      runWhenIdle: (action) => {
        if (!deferUntilIdle(action)) action();
      },
      deferUntilIdle,
      cancelDeferredAction: () => {
        runtime.runSync(FiberHandle.clear(waiting));
      },
      discardPending: () => {
        // The waiting submit first: emptying the pastes would release it.
        runtime.runSync(
          Effect.andThen(FiberHandle.clear(waiting), FiberSet.clear(inFlight)),
        );
      },
    };
  });
  return pastes;
}
