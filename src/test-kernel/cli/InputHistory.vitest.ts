// Persistent ↑/↓ + Ctrl-R input history for the chat TUI input bar.

import { describe, expect, beforeEach } from 'vitest';
import { it } from '@effect/vitest';
import { Effect, Exit, Layer, Scope } from 'effect';

import { GlobalDatabase } from '@texra-ai/harness/node';
import { loadInputHistory } from '@cli/chat/tui/history/inputHistory';
import { globalDatabaseLayer } from '@controllers/session/databaseLayer';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';

const tempDirs = useTempDirs();

/** The process handle the CLI reads its history through, over a temp root. */
const onGlobalDatabase = <A, E>(
  storage: string,
  effect: Effect.Effect<A, E, GlobalDatabase>,
) =>
  effect.pipe(
    Effect.provide(
      globalDatabaseLayer(storage).pipe(
        Layer.provide(nodePlatformLayer),
        Layer.orDie,
      ),
    ),
  );

describe('CLI TUI input history', () => {
  let storage: string;
  beforeEach(async () => {
    storage = await makeTempDir('texra-input-history-', tempDirs);
  });

  it.live('persists entries across loads and skips adjacent duplicates', () =>
    onGlobalDatabase(
      storage,
      Effect.gen(function* () {
        // A load's scope closes once every entry pushed through it is stored.
        const load = (scope: Scope.Scope) =>
          loadInputHistory.pipe(
            Scope.provide(scope),
            Effect.map(({ history }) => history),
          );
        const first = yield* Scope.make();
        const history = yield* load(first);
        yield* Effect.all(
          [history.push('alpha'), history.push('alpha'), history.push('beta')],
          { concurrency: 'unbounded' },
        );
        yield* history.push('   ');
        yield* Scope.close(first, Exit.void);

        const stale = yield* Scope.make();
        const reloaded = yield* load(stale);

        expect(reloaded.length()).toBe(2);
        expect(reloaded.at(0)).toBe('alpha');
        expect(reloaded.at(1)).toBe('beta');
        // Another CLI writes between two submissions identical in this cache.
        const other = yield* Scope.make();
        yield* Effect.flatMap(load(other), (h) => h.push('gamma'));
        yield* Scope.close(other, Exit.void);
        yield* reloaded.push('beta');
        yield* Scope.close(stale, Exit.void);
        const { history: combined } = yield* Effect.scoped(loadInputHistory);
        expect(
          Array.from({ length: combined.length() }, (_, index) =>
            combined.at(index),
          ),
        ).toEqual(['alpha', 'beta', 'gamma', 'beta']);
      }),
    ),
  );
});
