// Local imports - platform
import type {
  ConfigInspection,
  ConfigProvider,
  ConfigTarget,
} from '@platform/interfaces/config';
import type { Disposable } from '@platform/interfaces/disposable';

export class MemoryConfigProvider implements ConfigProvider {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return this.values.has(key)
      ? (this.values.get(key) as T)
      : (defaultValue as T);
  }

  async update<T>(
    key: string,
    value: T,
    _target?: ConfigTarget,
  ): Promise<void> {
    this.values.set(key, value);
  }

  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined {
    if (!this.values.has(key)) return undefined;
    const value = this.values.get(key) as T;
    return { globalValue: value, effectiveValue: value };
  }

  isExplicitlySet(key: string): boolean {
    return this.values.has(key);
  }

  watch(
    _key: string | readonly string[] | RegExp,
    _listener: () => void,
  ): Disposable {
    return { dispose: () => {} };
  }
}
