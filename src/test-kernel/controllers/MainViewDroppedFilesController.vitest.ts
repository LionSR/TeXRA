import { describe, expect, it } from 'vitest';

import { attachDroppedPaths } from '@controllers/mainView/MainViewDroppedFilesController';

const CONTEXT_EXTENSIONS = ['.bib', '.bbl', '.cls', '.sty', '.txt'];

describe('MainViewDroppedFilesController', () => {
  it('attaches only the extensions the target field accepts', () => {
    expect(
      attachDroppedPaths(['notes.txt', 'paper/main.tex'], CONTEXT_EXTENSIONS),
    ).toEqual({
      paths: ['notes.txt'],
      attachedCount: 1,
      rejectedCount: 1,
    });
  });

  it('deduplicates accepted files while counting invalid candidates', () => {
    expect(
      attachDroppedPaths(
        ['paper/main.tex', 'paper/main.tex', null, 'build/cache.tmp'],
        ['.tex'],
      ),
    ).toEqual({
      paths: ['paper/main.tex'],
      attachedCount: 1,
      rejectedCount: 2,
    });
  });
});
