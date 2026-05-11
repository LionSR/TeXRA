// Local imports - platform
import { MemoryStateStore } from '@platform/defaults/memoryState';
import type {
  ConfigInspection,
  ConfigProvider,
  ConfigTarget,
} from '@platform/interfaces/config';
import type { Disposable } from '@platform/interfaces/disposable';

export class MemoryConfigProvider implements ConfigProvider {
  private readonly values = new MemoryStateStore();

  get<T>(key: string, defaultValue?: T): T {
    return this.values.get(key, defaultValue);
  }

  async update<T>(
    key: string,
    value: T,
    _target?: ConfigTarget,
  ): Promise<void> {
    await this.values.update(key, value);
  }

  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined {
    if (!this.values.has(key)) return undefined;
    const value = this.values.get<T>(key);
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
