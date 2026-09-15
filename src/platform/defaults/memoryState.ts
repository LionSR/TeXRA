// Third-party imports
import { Effect } from 'effect';

// Local imports - platform
import type { StateStore, StateWriteFailed } from '../interfaces';

/** In-memory platform state store for CLI, tests, and lightweight hosts. */
export class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    const value = this.values.get(key);
    return value === undefined ? (defaultValue as T) : (value as T);
  }

  /** A map write cannot fail, so the port's error channel stays empty. */
  update(key: string, value: unknown): Effect.Effect<void, StateWriteFailed> {
    return Effect.sync(() => {
      if (value === undefined) {
        this.values.delete(key);
        return;
      }
      this.values.set(key, value);
    });
  }
}
