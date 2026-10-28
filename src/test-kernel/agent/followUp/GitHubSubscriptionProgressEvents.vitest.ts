// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, Layer, Scope } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { Secrets } from '@platform/secrets';
import type { RunId } from '@shared/schemas';
import { FakeSecrets } from '@test/support/FakePlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { RunSubscriptionRegistry } from '@texra/tools/github/RunSubscriptionRegistry';

/** A polling source that records its active keys and key listeners. */
class RegistryTestSource {
  private readonly keys = new Set<string>();
  private readonly keyListeners = new Set<(keys: readonly string[]) => void>();

  activeKeys(): readonly string[] {
    return [...this.keys];
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  keyListenerCount(): number {
    return this.keyListeners.size;
  }

  onKeysChanged(listener: (keys: readonly string[]) => void): {
    dispose(): void;
  } {
    this.keyListeners.add(listener);
    return { dispose: () => this.keyListeners.delete(listener) };
  }

  subscribe(input: string): Effect.Effect<{ dispose(): void }> {
    return Effect.sync(() => {
      this.keys.add(input);
      this.emitKeysChanged();
      return {
        dispose: () => {
          this.keys.delete(input);
          this.emitKeysChanged();
        },
      };
    });
  }

  private emitKeysChanged(): void {
    const keys = [...this.keys];
    for (const listener of this.keyListeners) listener(keys);
  }
}

describe('GitHub run subscriptions', () => {
  // A disposed registry must stop every poll it started: a binding left
  // behind keeps spending the GitHub rate limit for a run that is gone.
  it.effect('closing releases every binding and the source-key listener', () =>
    Effect.gen(function* () {
      const source = new RegistryTestSource();
      const scope = yield* Scope.make();
      const registry = yield* RunSubscriptionRegistry.make<string, string>({
        name: 'test subscriptions',
        source,
        keyOf: (input) => input,
      }).pipe(Scope.provide(scope));

      yield* registry
        .bind('stream-a' as RunId, 'owner/repo', {
          send: () => Effect.succeed({ status: 'sent' as const }),
          onClosed: () => () => {},
        })
        .pipe(
          Effect.provide(
            Layer.merge(Secrets.layer(new FakeSecrets()), testHttpClientLayer),
          ),
        );
      expect(source.keyListenerCount()).toBe(1);

      yield* Scope.close(scope, Exit.void);

      expect(source.activeKeys()).toEqual([]);
      expect(source.keyListenerCount()).toBe(0);
      expect(registry.list(['owner/repo'])).toEqual([
        { key: 'owner/repo', runIds: [] },
      ]);
    }),
  );
});
