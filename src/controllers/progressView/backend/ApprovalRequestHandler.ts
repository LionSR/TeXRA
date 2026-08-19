import { APPROVAL_REPLACED_CAUSE } from '@shared/copy/interactionCancellation';

type PendingPresentation<T> = {
  readonly mode: 'presentation';
  readonly item: T;
};

type PendingInteraction<T, Result> = {
  readonly mode: 'interaction';
  readonly item: T;
  readonly cancellationResult: (cause?: string) => Result;
  readonly complete: (result: Result) => void;
};

type PendingRequest<T, Result> =
  PendingPresentation<T> | PendingInteraction<T, Result>;

interface ApprovalInteractionOptions<Result> {
  cancellationResult: (cause?: string) => Result;
}

/**
 * Owns the complete lifecycle of one progress-view request kind: payload,
 * delivery state, replay, optional response callback, cancellation metadata,
 * and presentation removal.
 */
export class ApprovalRequestHandler<
  T extends { streamId: string },
  K extends keyof T,
  Result = never,
> {
  private readonly pending = new Map<string, PendingRequest<T, Result>>();
  /** IDs already sent to the current webview target. */
  private readonly delivered = new Set<string>();

  constructor(
    private readonly idField: K,
    private readonly sendShow: (item: T) => void,
    private readonly sendDismiss: (id: string) => void,
    private readonly canSend: () => boolean,
  ) {}

  /** Present an item that has no response-bearing promise. */
  show(item: T): void {
    const id = this.idFor(item);
    this.removeExisting(id, APPROVAL_REPLACED_CAUSE);
    this.register(id, { mode: 'presentation', item });
  }

  /** Present an item and retain its typed completion callback beside it. */
  request(
    item: T,
    options: ApprovalInteractionOptions<Result>,
  ): Promise<Result> {
    const id = this.idFor(item);
    this.removeExisting(id, APPROVAL_REPLACED_CAUSE);

    return new Promise<Result>((complete) => {
      // `register` rethrows a delivery failure, which the promise executor
      // converts into a rejection automatically.
      this.register(id, {
        mode: 'interaction',
        item,
        cancellationResult: options.cancellationResult,
        complete,
      });
    });
  }

  /** Stage presentation data for the next replay without delivering it now. */
  protected stagePresentationForReplay(item: T): string {
    const id = this.idFor(item);
    const existing = this.pending.get(id);
    if (existing?.mode === 'interaction') {
      this.completeEntry(
        id,
        existing,
        existing.cancellationResult(APPROVAL_REPLACED_CAUSE),
        false,
      );
    }
    this.pending.set(id, { mode: 'presentation', item });
    this.delivered.delete(id);
    return id;
  }

  /** Complete one response-bearing request and remove its presentation. */
  complete(id: string, result: Result): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.mode !== 'interaction') return false;
    return this.completeEntry(id, entry, result, true);
  }

  /** Complete every matching response-bearing request. */
  completeWhere(predicate: (item: T) => boolean, result: Result): number {
    let completed = 0;
    for (const [id, entry] of [...this.pending]) {
      if (
        entry.mode === 'interaction' &&
        predicate(entry.item) &&
        this.completeEntry(id, entry, result, true)
      ) {
        completed += 1;
      }
    }
    return completed;
  }

  /** Cancel every matching response-bearing request. */
  cancelWhere(predicate: (item: T) => boolean, cause?: string): number {
    let cancelled = 0;
    for (const [id, entry] of [...this.pending]) {
      if (
        entry.mode === 'interaction' &&
        predicate(entry.item) &&
        this.completeEntry(id, entry, entry.cancellationResult(cause), true)
      ) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /** Remove one presentation-only item. */
  dismiss(id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.mode !== 'presentation') return false;
    return this.removeEntry(id, entry, true);
  }

  /** Re-send all pending items to a new or reset target. */
  replay(): void {
    this.delivered.clear();
    for (const [id, entry] of this.pending) {
      this.deliver(id, entry);
    }
  }

  get(id: string): T | undefined {
    return this.pending.get(id)?.item;
  }

  /** Check if any pending item is associated with the given stream. */
  hasPendingForStream(streamId: string): boolean {
    for (const { item } of this.pending.values()) {
      if (!item.streamId || item.streamId === streamId) return true;
    }
    return false;
  }

  /**
   * Silently release every item tied to `streamId`. Response-bearing entries
   * are cancelled so cleanup can never orphan their promises.
   */
  releaseForStream(streamId: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.item.streamId === streamId) this.releaseSilently(id, entry);
    }
  }

  /** Silently release all pending items without orphaning interactions. */
  clear(): void {
    for (const [id, entry] of [...this.pending]) {
      this.releaseSilently(id, entry);
    }
  }

  /** Release one entry without notifying the webview (dismiss/cancel cleanup). */
  private releaseSilently(id: string, entry: PendingRequest<T, Result>): void {
    this.settleEntry(id, entry, undefined, false);
  }

  /** Remove an entry, cancelling it first when it bears a response promise. */
  private settleEntry(
    id: string,
    entry: PendingRequest<T, Result>,
    cause: string | undefined,
    notify: boolean,
  ): void {
    if (entry.mode === 'interaction') {
      this.completeEntry(id, entry, entry.cancellationResult(cause), notify);
    } else {
      this.removeEntry(id, entry, notify);
    }
  }

  private idFor(item: T): string {
    return String(item[this.idField]);
  }

  /** Track an entry and deliver it, rolling the entry back if delivery throws. */
  private register(id: string, entry: PendingRequest<T, Result>): void {
    this.pending.set(id, entry);
    try {
      this.deliver(id, entry);
    } catch (error) {
      this.removeEntry(id, entry, false);
      throw error;
    }
  }

  private deliver(id: string, entry: PendingRequest<T, Result>): void {
    if (!this.canSend() || this.delivered.has(id)) return;
    this.delivered.add(id);
    try {
      this.sendShow(entry.item);
    } catch (error) {
      if (this.pending.get(id) === entry) this.delivered.delete(id);
      throw error;
    }
  }

  private removeExisting(id: string, cause: string): void {
    const entry = this.pending.get(id);
    if (entry) this.settleEntry(id, entry, cause, true);
  }

  private completeEntry(
    id: string,
    entry: PendingInteraction<T, Result>,
    result: Result,
    notify: boolean,
  ): boolean {
    if (!this.removeEntry(id, entry, false)) return false;
    entry.complete(result);
    if (notify && this.canSend()) this.sendDismiss(id);
    return true;
  }

  private removeEntry(
    id: string,
    entry: PendingRequest<T, Result>,
    notify: boolean,
  ): boolean {
    if (this.pending.get(id) !== entry) return false;
    this.pending.delete(id);
    this.delivered.delete(id);
    if (notify && this.canSend()) this.sendDismiss(id);
    return true;
  }
}
