// Persistent ↑/↓ + Ctrl-R input history for the chat TUI input bar.

import { describe, expect, beforeEach } from 'vitest';
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';

import { loadInputHistory } from '@cli/chat/tui/history/inputHistory';
import { globalDatabaseLayer } from '@controllers/session/Database';
import { processOwnerId } from '@platform/defaults/nodeProcesses';
import { GlobalDatabase } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
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
        Layer.provide(ProcessIdentity.layer(processOwnerId('vitest'))),
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
        const history = yield* loadInputHistory;
        yield* Effect.all(
          [history.push('alpha'), history.push('alpha'), history.push('beta')],
          { concurrency: 'unbounded' },
        );
        yield* history.push('   ');

        const reloaded = yield* loadInputHistory;

        expect(reloaded.length()).toBe(2);
        expect(reloaded.at(0)).toBe('alpha');
        expect(reloaded.at(1)).toBe('beta');
        expect([history.at(0), history.at(1)]).toEqual([
          reloaded.at(0),
          reloaded.at(1),
        ]);
        // Another CLI writes between two submissions identical in this cache.
        yield* reloaded.push('gamma');
        yield* history.push('beta');
        const combined = yield* loadInputHistory;
        expect(
          Array.from({ length: combined.length() }, (_, index) =>
            combined.at(index),
          ),
        ).toEqual(['alpha', 'beta', 'gamma', 'beta']);
      }),
    ),
  );

  it.live('reverse-finds the most recent matching entry first', () =>
    onGlobalDatabase(
      storage,
      Effect.gen(function* () {
        const history = yield* loadInputHistory;
        yield* history.push('build the project');
        yield* history.push('run the tests');
        yield* history.push('build the docs');

        const newest = history.reverseFind('build');
        expect(newest).toEqual({ value: 'build the docs', index: 2 });

        const older = history.reverseFind('build', newest?.index);
        expect(older).toEqual({ value: 'build the project', index: 0 });
      }),
    ),
  );
});
