/**
 * Generic handler for approval/prompt requests with pending state management.
 * Eliminates duplication across tool edit, bash approval, retry, and proposal handlers.
 *
 * The `delivered` set tracks IDs sent to the current webview target so that
 * show() won't duplicate an item that replay() already sent.  replay() always
 * clears the set first — every caller replays because the target changed or
 * lost state, so prior delivery info is meaningless.
 */
export class ApprovalRequestHandler<
  T extends { streamId: string },
  K extends keyof T,
> {
  private readonly pending = new Map<string, T>();
  /** IDs already sent to the current webview target. */
  private readonly delivered = new Set<string>();

  constructor(
    private readonly idField: K,
    private readonly sendShow: (item: T) => void,
    private readonly sendResolve: (id: string) => void,
    private readonly canSend: () => boolean,
  ) {}

  /** True when nothing is currently pending — used by callers that
   *  want to skip an expensive hydration on warm view reactivations. */
  get pendingSize(): number {
    return this.pending.size;
  }

  show(item: T): void {
    const id = String(item[this.idField]);
    this.pending.set(id, item);
    if (this.canSend() && !this.delivered.has(id)) {
      this.delivered.add(id);
      this.sendShow(item);
    }
  }

  resolve(id: string): void {
    this.pending.delete(id);
    this.delivered.delete(id);
    if (this.canSend()) this.sendResolve(id);
  }

  /** Re-send all pending items. Clears delivery tracking first — the target
   *  is either new or lost state, so everything must be (re-)delivered. */
  replay(): void {
    this.delivered.clear();
    for (const [id, item] of this.pending.entries()) {
      this.delivered.add(id);
      this.sendShow(item);
    }
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
