import { Effect, type Fiber, FiberSet, Scope } from 'effect';

import { warn as logWarning } from '@logger/logUtils';

export class ImagePasteQueue {
  // The set lives as long as the input bar that owns the queue, so its scope
  // is never closed; a discard interrupts the in-flight pastes instead.
  private readonly pastes = Effect.runSync(
    FiberSet.make<void>().pipe(Scope.provide(Scope.makeUnsafe())),
  );
  private deferredAction: (() => void) | null = null;

  get hasPending(): boolean {
    return Effect.runSync(FiberSet.size(this.pastes)) > 0;
  }

  get hasDeferredAction(): boolean {
    return this.deferredAction !== null;
  }

  add(paste: Fiber.Fiber<void>): void {
    FiberSet.addUnsafe(this.pastes, paste);
  }

  runWhenIdle(action: () => void): void {
    if (!this.deferUntilIdle(action)) action();
  }

  /** First submit wins while an image paste is pending; it runs once the set
   *  drains. A throw out of the action is logged, not lost. */
  deferUntilIdle(action: () => void): boolean {
    if (!this.hasPending) return false;
    if (this.deferredAction !== null) return true;
    this.deferredAction = action;
    Effect.runFork(
      FiberSet.awaitEmpty(this.pastes).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const deferred = this.deferredAction;
            this.deferredAction = null;
            deferred?.();
          }),
        ),
        Effect.tapCause((cause) =>
          Effect.sync(() =>
            logWarning('cli.tui', 'The deferred image-paste action failed.', {
              data: cause,
            }),
          ),
        ),
      ),
    );
    return true;
  }

  cancelDeferredAction(): void {
    this.deferredAction = null;
  }

  /** Interrupt all work that belongs to a discarded draft. */
  discardPending(): void {
    this.deferredAction = null;
    Effect.runFork(FiberSet.clear(this.pastes));
  }
}
