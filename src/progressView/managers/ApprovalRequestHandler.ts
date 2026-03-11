/**
 * Generic handler for approval/prompt requests with pending state management.
 * Eliminates duplication across tool edit, bash approval, retry, and proposal handlers.
 *
 * Tracks which items have been delivered to the current webview instance so
 * that replay() only re-sends items the frontend hasn't seen yet. Call
 * resetDeliveryTracking() when the webview is recreated (frontend state lost).
 */
export class ApprovalRequestHandler<
  T extends { streamId: string },
  K extends keyof T,
> {
  private readonly pending = new Map<string, T>();
  /** IDs already sent to the current webview instance. */
  private readonly delivered = new Set<string>();

  constructor(
    private readonly idField: K,
    private readonly sendShow: (item: T) => void,
    private readonly sendResolve: (id: string) => void,
    private readonly canSend: () => boolean,
  ) {}

  show(item: T): void {
    const id = String(item[this.idField]);
    this.pending.set(id, item);
    if (this.canSend()) {
      this.delivered.add(id);
      this.sendShow(item);
    }
  }

  resolve(id: string): void {
    this.pending.delete(id);
    this.delivered.delete(id);
    if (this.canSend()) this.sendResolve(id);
  }

  replay(): void {
    for (const [id, item] of this.pending.entries()) {
      if (!this.delivered.has(id)) {
        this.delivered.add(id);
        this.sendShow(item);
      }
    }
  }

  /** Clear delivery tracking when the webview is recreated (state is lost). */
  resetDeliveryTracking(): void {
    this.delivered.clear();
  }

  get(id: string): T | undefined {
    return this.pending.get(id);
  }

  /** Check if any pending item is associated with the given stream. */
  hasPendingForStream(streamId: string): boolean {
    for (const item of this.pending.values()) {
      if (!item.streamId || item.streamId === streamId) return true;
    }
    return false;
  }
}
