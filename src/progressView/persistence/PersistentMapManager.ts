/**
 * Storage interface matching vscode.Memento API.
 * Used by ProgressViewState and StreamLogStore for workspace state access.
 */
export interface MementoStorage {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update<T>(key: string, value: T): Thenable<void>;
}
