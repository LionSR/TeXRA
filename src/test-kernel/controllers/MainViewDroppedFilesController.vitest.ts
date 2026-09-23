import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { attachDroppedPaths } from '@controllers/mainView/MainViewDroppedFilesController';

const CONTEXT_EXTENSIONS = ['.bib', '.bbl', '.cls', '.sty', '.txt'];

describe('MainViewDroppedFilesController', () => {
  it.effect('attaches only the extensions the target field accepts', () =>
    Effect.gen(function* () {
      expect(
        yield* attachDroppedPaths(
          ['notes.txt', 'paper/main.tex'],
          CONTEXT_EXTENSIONS,
        ),
      ).toEqual({
        paths: ['notes.txt'],
        attachedCount: 1,
        rejectedCount: 1,
      });
    }),
  );

  it.effect(
    'deduplicates accepted files while counting invalid candidates',
    () =>
      Effect.gen(function* () {
        expect(
          yield* attachDroppedPaths(
            ['paper/main.tex', 'paper/main.tex', null, 'build/cache.tmp'],
            ['.tex'],
          ),
        ).toEqual({
          paths: ['paper/main.tex'],
          attachedCount: 1,
          rejectedCount: 2,
        });
      }),
  );

  it.effect('fails with Rejected, not a defect, when nothing attaches', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        attachDroppedPaths(['paper/main.tex', null], CONTEXT_EXTENSIONS),
      );
      expect(failure._tag).toBe('Rejected');
    }),
  );
});
