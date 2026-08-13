/**
 * Manages toggle/collapse states with optional persistence callback.
 */
export class ToggleStateStore {
  private states = new Map<string, boolean>();

  constructor(private readonly saveCallback?: () => void) {}

  set(id: string, value: boolean): void {
    if (!id) return;
    this.states.set(id, value);
    this.saveCallback?.();
  }

  get(id: string): boolean | undefined {
    return this.states.get(id);
  }

  entries(): [string, boolean][] {
    return [...this.states.entries()];
  }

  load(data: [string, boolean][]): void {
    this.states = new Map(data);
  }
}
