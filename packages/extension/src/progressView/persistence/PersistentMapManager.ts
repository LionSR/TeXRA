/**
 * Storage interface matching vscode.Memento API.
 * Used by ProgressViewState and StreamLogStore for workspace state access.
 */
export interface MementoStorage {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  /**
   * Set a key's value, or pass `undefined` to delete the entry. Mirrors
   * `vscode.Memento.update`, which uses `undefined` as the delete sentinel.
   */
  update<T>(key: string, value: T | undefined): Thenable<void>;
}
