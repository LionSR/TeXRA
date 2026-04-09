/**
 * Platform key-value state store interface.
 * Matches the vscode.Memento surface for compatibility.
 */
export interface StateStore {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}
