// Third-party imports
import { Effect, Result } from 'effect';

// Local imports - platform
import type { StateStore, StateWriteFailed } from '../interfaces';

/** In-memory platform state store for CLI, tests, and lightweight hosts. */
export class MemoryStateStore implements StateStore {
  private readonly values: Map<string, unknown>;

  constructor(values: Record<string, unknown> = {}) {
    this.values = new Map(Object.entries(values));
  }

  get(key: string): Effect.Effect<unknown> {
    return Effect.sync(() => this.values.get(key));
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

  /** Synchronous, so no other change can land between the read and the
   *  write. */
  modify<T, E>(
    key: string,
    change: (current: unknown) => Result.Result<T, E>,
  ): Effect.Effect<T, E | StateWriteFailed> {
    return Effect.suspend(() => {
      const result = change(this.values.get(key));
      if (Result.isFailure(result)) return Effect.fail(result.failure);
      if (result.success === undefined) this.values.delete(key);
      else this.values.set(key, result.success);
      return Effect.succeed(result.success);
    });
  }
}
