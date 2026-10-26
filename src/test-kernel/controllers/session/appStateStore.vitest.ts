/**
 * The durable boundary of host and application state: what a reopened store
 * reads back from the root's database, and what a second writer on the same
 * database does to a live reader, and when its owner's scope releases it.
 */

import { it } from '@effect/vitest';
import { Context, Effect, Layer, Result } from 'effect';
import { describe, expect } from 'vitest';

import { globalAppStateLayer } from '@controllers/session/appStateStore';
import { globalDatabaseLayer } from '@controllers/session/Database';
import { processOwnerId } from '@platform/defaults/nodeProcesses';
import { AppState } from '@platform/interfaces';
import { ProcessIdentity } from '@shared/session/sessionEvents';

import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';

describe('application state on SQLite', () => {
  const tempDirs = useTempDirs();
  /** Independent state over its own database, in the caller's scope. */
  const openAppStateStore = (storage: string) =>
    Effect.map(
      Layer.build(
        globalAppStateLayer(storage).pipe(
          Layer.provide(globalDatabaseLayer(storage)),
        ),
      ),
      (context) => Context.get(context, AppState),
    );
  const openStore = (storage: string) =>
    openAppStateStore(storage).pipe(
      Effect.provide(ProcessIdentity.layer(processOwnerId('app-state-test'))),
      Effect.provide(nodePlatformLayer),
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
      yield* one.update('texra.kimiCode.prefer', true);
      yield* two.update('texra.glm.codingPlan', false);
      yield* one.update('texra.memory.enabled', true);

      expect(yield* two.get('texra.kimiCode.prefer')).toBe(true);
      expect(yield* one.get('texra.glm.codingPlan')).toBe(false);
      expect(yield* two.get('texra.memory.enabled')).toBe(true);
      yield* two.update('texra.kimiCode.prefer', undefined);
      expect(yield* one.get('texra.kimiCode.prefer')).toBeUndefined();

      // Concurrent read-modify-writes of one key both land: each changes
      // the value the other committed, never a stale read of its own.
      const add = (store: typeof one, id: string) =>
        store.modify('texra.disabledTools', (stored) =>
          Result.succeed([...((stored as string[] | undefined) ?? []), id]),
        );
      yield* Effect.all([add(one, 'a'), add(two, 'b')], {
        concurrency: 'unbounded',
      });
      expect(
        [...((yield* one.get('texra.disabledTools')) as string[])].sort(),
      ).toEqual(['a', 'b']);
    }),
  );
});
