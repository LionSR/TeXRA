// Third-party imports
import { Effect, Result } from 'effect';

// Local imports - platform
import type { StateStore, StateWriteFailed } from '@shared/config/settings';

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
    return this.modify([key], () =>
      Result.succeed([undefined, { [key]: value }]),
    );
  }

  /** Synchronous, so no other change can land between the read and the
   *  write. */
  modify<K extends string, A, E>(
    keys: readonly K[],
    change: (
      current: Readonly<Record<K, unknown>>,
    ) => Result.Result<
      readonly [A] | readonly [A, Readonly<Record<K, unknown>>],
      E
    >,
  ): Effect.Effect<A, E | StateWriteFailed> {
    return Effect.suspend(() => {
      const result = change(
        // cast: one entry for each of `keys`.
        Object.fromEntries(
          keys.map((key) => [key, this.values.get(key)]),
        ) as Readonly<Record<K, unknown>>,
      );
      if (Result.isFailure(result)) return Effect.fail(result.failure);
      const [answer, next] = result.success;
      if (next !== undefined) {
        for (const key of keys) {
          if (next[key] === undefined) this.values.delete(key);
          else this.values.set(key, next[key]);
        }
      }
      return Effect.succeed(answer);
    });
  }
}
