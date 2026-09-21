import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { withTempDirEffect } from '@test/support/tempDirPlatform';
import { writeFileAtomic } from '@utils/files/fsDurability';

describe('fsDurability.writeFileAtomic', () => {
  it.live(
    'writes content, overwrites in place, and leaves no temp residue',
    () =>
      Effect.gen(function* () {
        yield* withTempDirEffect('texra-atomic-', (dir) =>
          Effect.gen(function* () {
            const target = path.join(dir, 'flow.json');

            yield* writeFileAtomic(target, Buffer.from('{"step":1}'));
            expect(yield* Effect.promise(() => readFile(target, 'utf8'))).toBe(
              '{"step":1}',
            );

            // Overwrite — the crash-sensitive path (re-serialized run state).
            yield* writeFileAtomic(target, Buffer.from('{"step":2}'));
            expect(yield* Effect.promise(() => readFile(target, 'utf8'))).toBe(
              '{"step":2}',
            );

            // The temp file must have been renamed away, not abandoned.
            const entries = yield* Effect.promise(() => readdir(dir));
            expect(entries).toEqual(['flow.json']);
          }),
        );
      }),
  );
});
