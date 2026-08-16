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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const failures: unknown[] = [];
    for (let i = this.disposables.length - 1; i >= 0; i--) {
      try {
        disposeOne(this.disposables[i]);
      } catch (error) {
        failures.push(error);
      }
    }
    this.disposables.length = 0;

    throwAggregated(failures, 'Multiple resources failed to dispose');
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
