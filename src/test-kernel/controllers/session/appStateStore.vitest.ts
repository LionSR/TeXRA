/**
 * The durable boundary of host and application state: what a reopened store
 * reads back from the root's database, and what a second writer on the same
 * database does to a live reader, and when its owner's scope releases it.
 */
import { it } from '@effect/vitest';
import { Effect, Exit, Scope } from 'effect';
import { describe, expect } from 'vitest';

import { openAppStateStore } from '@controllers/session/appStateStore';
import { processOwnerId } from '@platform/defaults/nodeProcesses';
import { ProcessIdentity } from '@shared/session/sessionEvents';

import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';

describe('application state on SQLite', () => {
  const tempDirs = useTempDirs();
  const openStore = (storage: string) =>
    openAppStateStore(storage).pipe(
      Effect.provide(ProcessIdentity.layer(processOwnerId('app-state-test'))),
      Effect.provide(nodePlatformLayer),
    );

  it.live('reads back the latest value of each key after reopening', () =>
    Effect.gen(function* () {
      const storage = yield* Effect.promise(() =>
        makeTempDir('texra-app-state-', tempDirs),
      );
      const first = yield* openStore(storage);
      yield* first.update('texra.modelSelection', ['a']);
      yield* first.update('texra.modelSelection', ['b']);
      yield* first.update('goals:index', { open: 1 });
      yield* first.update('texra.dropped', 'gone');
      yield* first.update('texra.dropped', undefined);

      const reopened = yield* openStore(storage);
      expect(yield* reopened.get('texra.modelSelection')).toEqual(['b']);
      expect(yield* reopened.get('goals:index')).toEqual({ open: 1 });
      expect(yield* reopened.get('texra.dropped', 'default')).toBe('default');
    }),
  );

  it.live('keeps both writers when two stores share one database', () =>
    Effect.gen(function* () {
      const storage = yield* Effect.promise(() =>
        makeTempDir('texra-app-state-', tempDirs),
      );
      const one = yield* openStore(storage);
      const two = yield* openStore(storage);
      // Interleaved, as two hosts on one project are: the whole-file store
      // this replaces would have lost whichever key flushed second.
      yield* one.update('texra.useOpenRouter', true);
      yield* two.update('texra.glm.codingPlan', false);
      yield* one.update('texra.memory.enabled', true);

      expect(yield* two.get('texra.useOpenRouter')).toBe(true);
      expect(yield* one.get('texra.glm.codingPlan')).toBe(false);
      expect(yield* two.get('texra.memory.enabled')).toBe(true);
      yield* two.update('texra.useOpenRouter', undefined);
      expect(yield* one.get('texra.useOpenRouter', 'absent')).toBe('absent');
    }),
  );

  it.live('fails the caller when a value is not JSON', () =>
    Effect.gen(function* () {
      const storage = yield* Effect.promise(() =>
        makeTempDir('texra-app-state-', tempDirs),
      );
      const store = yield* openStore(storage);
      yield* store.update('texra.customAgentPresets', ['valid']);
      const failure = yield* Effect.flip(
        store.update('texra.customAgentPresets', () => undefined),
      );
      expect(failure._tag).toBe('StateWriteFailed');
      expect(failure.message).toContain('not JSON');
      expect(yield* store.get('texra.customAgentPresets')).toEqual(['valid']);
    }),
  );
  it.live(
    'releases the connection with its owner and reports failed reads',
    () =>
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          makeTempDir('texra-app-state-', tempDirs),
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const store = yield* Scope.provide(openStore(storage), scope);
        yield* store.update('value', 1);
        yield* Scope.close(scope, Exit.void);
        const failure = yield* Effect.flip(store.get('value'));
        expect(failure._tag).toBe('StateReadFailed');
        expect(failure.key).toBe('value');
        const reopened = yield* openStore(storage);
        expect(yield* reopened.get('value')).toBe(1);
      }),
  );
});
