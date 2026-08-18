import { throwAggregated } from '@utils/core';
import type { Disposable } from './interfaces';

type DisposableLike = Disposable | (() => void);

function disposeOne(disposable: DisposableLike): void {
  if (typeof disposable === 'function') disposable();
  else disposable.dispose();
}

/** LIFO owner for synchronous resources sharing one lifetime. */
export class DisposableStore implements Disposable {
  private readonly disposables: DisposableLike[] = [];
  private disposed = false;

  add<T extends DisposableLike>(disposable: T): T {
    if (this.disposed) disposeOne(disposable);
    else this.disposables.push(disposable);
    return disposable;
  }

  /**
   * Transfer ownership of every entry out of the store without disposing it.
   * For success paths whose resources outlive the assembling scope: the caller
   * (or the object the entries were built into) becomes the owner, and a later
   * `dispose()` of this store no longer reaches them.
   */
  move(): void {
    this.disposables.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const failures: unknown[] = [];
    for (const disposable of this.disposables.toReversed()) {
      try {
        disposeOne(disposable);
      } catch (error) {
        failures.push(error);
      }
    }
    this.disposables.length = 0;

    throwAggregated(failures, 'Multiple resources failed to dispose');
  }
}
