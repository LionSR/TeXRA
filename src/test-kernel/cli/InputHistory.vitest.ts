// Persistent ↑/↓ + Ctrl-R input history for the chat TUI input bar.

import { describe, expect, beforeEach } from 'vitest';
import { it } from '@effect/vitest';
import { Effect } from 'effect';

import { loadInputHistory } from '@cli/chat/tui/history/inputHistory';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempDirs = useTempDirs();

describe('CLI TUI input history', () => {
  let storage: string;
  beforeEach(async () => {
    storage = await makeTempDir('texra-input-history-', tempDirs);
  });

  it.live('exposes indexed entries for ↑/↓ history browsing', () =>
    Effect.gen(function* () {
      const history = yield* loadInputHistory(() => storage);

      expect(history.length()).toBe(0);
      expect(history.at(0)).toBeUndefined();

      yield* history.push('first message');
      yield* history.push('second message');

      expect(history.length()).toBe(2);
      expect(history.at(0)).toBe('first message');
      expect(history.at(1)).toBe('second message');
      expect(history.at(2)).toBeUndefined();
    }),
  );

  it.live('persists entries across loads and skips adjacent duplicates', () =>
    Effect.gen(function* () {
      const history = yield* loadInputHistory(() => storage);
      yield* Effect.all(
        [history.push('alpha'), history.push('alpha'), history.push('beta')],
        { concurrency: 'unbounded' },
      );
      yield* history.push('   ');

      const reloaded = yield* loadInputHistory(() => storage);

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
      const combined = yield* loadInputHistory(() => storage);
      expect(
        Array.from({ length: combined.length() }, (_, index) =>
          combined.at(index),
        ),
      ).toEqual(['alpha', 'beta', 'gamma', 'beta']);
    }),
  );

  it.live('reverse-finds the most recent matching entry first', () =>
    Effect.gen(function* () {
      const history = yield* loadInputHistory(() => storage);
      yield* history.push('build the project');
      yield* history.push('run the tests');
      yield* history.push('build the docs');

      const newest = history.reverseFind('build');
      expect(newest).toEqual({ value: 'build the docs', index: 2 });

      const older = history.reverseFind('build', newest?.index);
      expect(older).toEqual({ value: 'build the project', index: 0 });
    }),
  );
});
