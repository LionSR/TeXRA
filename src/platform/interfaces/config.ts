import type { Disposable } from './disposable';

export type ConfigTarget = 'global' | 'workspace';

export interface ConfigInspection<T = unknown> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
  effectiveValue?: T;
}

/**
 * Platform configuration provider interface.
 */
export interface ConfigProvider {
  get<T>(key: string, defaultValue?: T): T;
  update<T>(key: string, value: T, target?: ConfigTarget): Promise<void>;
  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined;
  isExplicitlySet(key: string): boolean;
  watch(
    key: string | readonly string[] | RegExp,
    listener: () => void,
  ): Disposable;
}
