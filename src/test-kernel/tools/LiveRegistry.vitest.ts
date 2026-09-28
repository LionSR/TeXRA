/**
 * The generational registry's contract (`@tools/liveRegistry`). Failure
 * modes it guards, written before the implementation:
 *
 * - a contribution patches the published generation in place, so a reader
 *   holding it sees entries change under it;
 * - closing the contributor's scope leaves its entries in `current`;
 * - a second owner's name silently overwrites the first owner's;
 * - an owner's later contribution is merged with, rather than replacing, its
 *   earlier one, or the earlier one is lost when the later closes first;
 * - a generation's resources are acquired per pin rather than shared, or are
 *   released while a pin still holds them, or never released once `current`
 *   has moved on (no drain);
 * - a rebuild with equal entries reuses an older generation's resources.
 */
import { it } from '@effect/vitest';
import { Effect, Exit, Scope, SubscriptionRef } from 'effect';
import { describe, expect } from 'vitest';

import { makeRegistry, type Generation } from '@tools/liveRegistry';

const names = (generation: Generation<string, number>) => [
  ...generation.entries.keys(),
];

const registryWithLog = (log: string[]) =>
  makeRegistry<string, number, string>({
    acquire: (generation) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          log.push(`acquire ${names(generation).join(',')}`);
          return names(generation).join(',');
        }),
        () =>
          Effect.sync(() => log.push(`release ${names(generation).join(',')}`)),
      ),
  });

describe('Registry', () => {
  it.effect(
    'rebuilds a new generation per change and withdraws on scope close',
    () =>
      Effect.gen(function* () {
        const registry = yield* registryWithLog([]);
        const a = yield* Scope.make();
        yield* registry
          .contribute('a', new Map([['x', 1]]))
          .pipe(Scope.provide(a));
        const first = yield* SubscriptionRef.get(registry.current);
        const b = yield* Scope.make();
        yield* registry
          .contribute('b', new Map([['y', 2]]))
          .pipe(Scope.provide(b));
        const second = yield* SubscriptionRef.get(registry.current);
        expect(names(first)).toEqual(['x']);
        expect(names(second)).toEqual(['x', 'y']);
        expect(second.id).toBeGreaterThan(first.id);
        expect(second.owners.get('y')).toBe('b');

        yield* Scope.close(a, Exit.void);
        expect(names(yield* SubscriptionRef.get(registry.current))).toEqual([
          'y',
        ]);
        // The published generation never changed under its reader.
        expect(names(second)).toEqual(['x', 'y']);
      }).pipe(Effect.scoped),
  );

  it.effect("refuses another owner's name and supersedes an owner's own", () =>
    Effect.gen(function* () {
      const registry = yield* registryWithLog([]);
      yield* registry.contribute('a', new Map([['x', 1]]));
      const clash = yield* Effect.flip(
        registry.contribute('b', new Map([['x', 2]])),
      );
      expect(clash._tag).toBe('RegistryConflict');
      expect(clash.message).toBe(
        'b contributes "x", which a already contributes.',
      );
      expect(
        (yield* SubscriptionRef.get(registry.current)).entries.get('x'),
      ).toBe(1);

      const later = yield* Scope.make();
      yield* registry
        .contribute('a', new Map([['x', 3]]))
        .pipe(Scope.provide(later));
      expect(
        (yield* SubscriptionRef.get(registry.current)).entries.get('x'),
      ).toBe(3);
      yield* Scope.close(later, Exit.void);
      expect(
        (yield* SubscriptionRef.get(registry.current)).entries.get('x'),
      ).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    'shares a generation between pins and drains it after the last pin',
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const registry = yield* registryWithLog(log);
        const owner = yield* Scope.make();
        yield* registry
          .contribute('a', new Map([['x', 1]]))
          .pipe(Scope.provide(owner));
        const one = yield* Scope.make();
        const two = yield* Scope.make();
        const pinned = yield* registry.pin.pipe(Scope.provide(one));
        yield* registry.pin.pipe(Scope.provide(two));
        expect(pinned.resources).toBe('x');
        expect(log).toEqual(['acquire x']);

        // `current` moves on; the old generation lives while pinned.
        yield* Scope.close(owner, Exit.void);
        const three = yield* Scope.make();
        yield* registry.pin.pipe(Scope.provide(three));
        yield* Scope.close(one, Exit.void);
        expect(log).toEqual(['acquire x', 'acquire ']);
        // Equal entries rebuilt are another generation, with its own
        // resources: a reloaded plugin's tools may run elsewhere.
        yield* registry.contribute('a', new Map([['x', 1]]));
        yield* registry.pin.pipe(Scope.provide(three));
        expect(log).toEqual(['acquire x', 'acquire ', 'acquire x']);
        yield* Scope.close(two, Exit.void);
        expect(log).toEqual([
          'acquire x',
          'acquire ',
          'acquire x',
          'release x',
        ]);
        yield* Scope.close(three, Exit.void);
      }).pipe(Effect.scoped),
  );
});
