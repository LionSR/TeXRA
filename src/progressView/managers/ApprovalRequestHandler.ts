/**
 * Generic handler for approval/prompt requests with pending state management.
 * Eliminates duplication across tool edit, bash approval, retry, and proposal handlers.
 */
export class ApprovalRequestHandler<
  T extends Record<string, unknown>,
  K extends keyof T,
> {
  private readonly pending = new Map<string, T>();

  constructor(
    private readonly idField: K,
    private readonly sendShow: (item: T) => void,
    private readonly sendResolve: (id: string) => void,
    private readonly canSend: () => boolean,
  ) {}

  show(item: T): void {
    const id = String(item[this.idField]);
    this.pending.set(id, item);
    if (this.canSend()) this.sendShow(item);
  }

  resolve(id: string): void {
    this.pending.delete(id);
    if (this.canSend()) this.sendResolve(id);
  }

  replay(): void {
    for (const item of this.pending.values()) {
      this.sendShow(item);
    }
  }

  get(id: string): T | undefined {
    return this.pending.get(id);
  }
}
