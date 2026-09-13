/**
 * The durable boundary of host and application state: what a reopened store
 * reads back from the root's database, and what a second writer on the same
 * database does to it. Everything above the port is the unchanged
 * `StateStore` surface, so this suite pins the persistence, not the callers.
 */
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { openAppStateStore } from '@controllers/session/appStateStore';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const runWrite = (write: Effect.Effect<void, Error>) =>
  Effect.runPromise(write);

describe('application state on SQLite', () => {
  const tempDirs = useTempDirs();
  const openStore = (storage: string) => openAppStateStore(storage, runWrite);

  it.effect('reads back the latest value of each key after reopening', () =>
    Effect.gen(function* () {
      const storage = yield* Effect.promise(() =>
        makeTempDir('texra-app-state-', tempDirs),
      );
      const first = yield* openStore(storage);
      yield* Effect.promise(() => first.update('texra.modelSelection', ['a']));
      yield* Effect.promise(() => first.update('texra.modelSelection', ['b']));
      yield* Effect.promise(() => first.update('goals:index', { open: 1 }));
      yield* Effect.promise(() => first.update('texra.dropped', 'gone'));
      yield* Effect.promise(() => first.update('texra.dropped', undefined));

      const reopened = yield* openStore(storage);
      expect(reopened.get('texra.modelSelection')).toEqual(['b']);
      expect(reopened.get('goals:index')).toEqual({ open: 1 });
      expect(reopened.get('texra.dropped', 'default')).toBe('default');
    }),
  );

  it.effect('keeps both writers when two stores share one database', () =>
    Effect.gen(function* () {
      const storage = yield* Effect.promise(() =>
        makeTempDir('texra-app-state-', tempDirs),
      );
      const one = yield* openStore(storage);
      const two = yield* openStore(storage);
      // Interleaved, as two hosts on one project are: the whole-file store
      // this replaces would have lost whichever key flushed second.
      yield* Effect.promise(() => one.update('texra.useOpenRouter', true));
      yield* Effect.promise(() => two.update('texra.glm.codingPlan', false));
      yield* Effect.promise(() => one.update('texra.memory.enabled', true));

      const reopened = yield* openStore(storage);
      expect(reopened.get('texra.useOpenRouter')).toBe(true);
      expect(reopened.get('texra.glm.codingPlan')).toBe(false);
      expect(reopened.get('texra.memory.enabled')).toBe(true);
    }),
  );

  it.effect('fails the caller when a value is not JSON', () =>
    Effect.gen(function* () {
      const storage = yield* Effect.promise(() =>
        makeTempDir('texra-app-state-', tempDirs),
      );
      const store = yield* openStore(storage);
      const failure = yield* Effect.flip(
        store.set('texra.customAgentPresets', () => undefined),
      );
      expect(failure.message).toContain('not JSON');
    }),
  );
});
