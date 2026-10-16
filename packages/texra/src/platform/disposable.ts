/**
 * A synchronous resource with one owner. Structurally compatible with VS
 * Code's Disposable and the unsubscribe callbacks Electron-side adapters use.
 */
export interface Disposable {
  dispose(): void;
}

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
    for (const disposable of this.disposables.toReversed()) {
      try {
        disposeOne(disposable);
      } catch (error) {
        failures.push(error);
      }
    }
    this.disposables.length = 0;

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Multiple resources failed to dispose',
      );
    }
  }
}
