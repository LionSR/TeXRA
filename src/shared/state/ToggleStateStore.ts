/**
 * Manages toggle/collapse states with optional persistence callback.
 */
export class ToggleStateStore {
  private states: Map<string, boolean> = new Map();
  private saveCallback?: () => void;

  constructor(saveCallback?: () => void) {
    this.saveCallback = saveCallback;
  }

  set(id: string, value: boolean): void {
    if (!id) return;
    this.states.set(id, value);
    this.saveCallback?.();
  }

  get(id: string): boolean | undefined {
    return this.states.get(id);
  }

  clearSelection(ids: string[]): void {
    for (const id of ids) {
      if (id) this.states.delete(id);
    }
    this.saveCallback?.();
  }

  clearAll(): void {
    this.states.clear();
    this.saveCallback?.();
  }

  entries(): Array<[string, boolean]> {
    return [...this.states.entries()];
  }

  load(data: Array<[string, boolean]>): void {
    if (Array.isArray(data)) {
      this.states = new Map(data);
    }
  }
}
