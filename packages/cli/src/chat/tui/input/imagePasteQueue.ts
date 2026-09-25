import { Effect, type Fiber } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import type { ProcessRuntime } from '@platform/processRuntime';

/** The in-flight clipboard image pastes of one input bar, as the fibers the
 *  runtime forked for them, and the submit deferred until they land. */
export class ImagePasteQueue {
  private readonly pastes = new Set<Fiber.Fiber<void>>();
  private deferredAction: (() => void) | null = null;

  get hasPending(): boolean {
    return this.pastes.size > 0;
  }

  get hasDeferredAction(): boolean {
    return this.deferredAction !== null;
  }

  /** `runtime` is the process runtime `paste` was forked on. */
  add(paste: Fiber.Fiber<void>, runtime: ProcessRuntime): void {
    this.pastes.add(paste);
    paste.addObserver(() => {
      this.pastes.delete(paste);
      this.flush(runtime);
    });
  }

  runWhenIdle(action: () => void): void {
    if (!this.deferUntilIdle(action)) action();
  }

  /** First submit wins while an image paste is pending. */
  deferUntilIdle(action: () => void): boolean {
    if (!this.hasPending) return false;
    this.deferredAction ??= action;
    return true;
  }

  cancelDeferredAction(): void {
    this.deferredAction = null;
  }

  /** Interrupt all work that belongs to a discarded draft. */
  discardPending(): void {
    this.deferredAction = null;
    for (const paste of this.pastes) paste.interruptUnsafe();
    this.pastes.clear();
  }

  /** Run the deferred submit once the last paste lands. A throw out of it is
   *  logged on the paste's runtime: it runs inside a fiber observer, where
   *  it would otherwise vanish. */
  private flush(runtime: ProcessRuntime): void {
    if (this.hasPending) return;
    const action = this.deferredAction;
    this.deferredAction = null;
    try {
      action?.();
    } catch (error) {
      runtime.runFork(
        Effect.logWarning('The deferred image-paste action failed.').pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel('cli.tui'),
        ),
      );
    }
  }
}
