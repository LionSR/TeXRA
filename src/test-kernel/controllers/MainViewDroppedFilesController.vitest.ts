import { describe, expect, it } from 'vitest';

import {
  normalizeMainViewFileExtension,
  planMainViewDroppedFileAttachments,
  type MainViewAllowedDropExtensions,
} from '@controllers/mainView/MainViewDroppedFilesController';

const ALLOWED_EXTENSIONS = {
  input: ['.tex'],
  context: ['.bib', '.bbl', '.cls', '.sty', '.txt'],
  media: ['.png', '.pdf'],
} as const satisfies MainViewAllowedDropExtensions;

describe('MainViewDroppedFilesController', () => {
  it('plans automatic dropped-file categories without VS Code state', () => {
    const plan = planMainViewDroppedFileAttachments({
      paths: [
        'paper/main.tex',
        'refs/library.bib',
        'styles/local.sty',
        'notes.txt',
        'figures/plot.png',
      ],
      allowedExtensions: ALLOWED_EXTENSIONS,
    });

    expect(plan).toEqual({
      filesByCategory: {
        input: ['paper/main.tex'],
        context: ['refs/library.bib', 'styles/local.sty', 'notes.txt'],
        media: ['figures/plot.png'],
      },
      attachedCount: 5,
      rejectedCount: 0,
    });
  });

  it('honors an explicit drop target and rejects unsupported targets', () => {
    expect(
      planMainViewDroppedFileAttachments({
        paths: ['notes.txt', 'paper/main.tex'],
        allowedExtensions: ALLOWED_EXTENSIONS,
        target: 'context',
      }),
    ).toMatchObject({
      filesByCategory: {
        input: [],
        context: ['notes.txt'],
        media: [],
      },
      attachedCount: 1,
      rejectedCount: 1,
    });

    expect(
      planMainViewDroppedFileAttachments({
        paths: ['paper/main.tex'],
        allowedExtensions: ALLOWED_EXTENSIONS,
        target: 'output',
      }),
    ).toMatchObject({
      attachedCount: 0,
      rejectedCount: 1,
    });
  });

  it('deduplicates accepted files while counting invalid candidates', () => {
    const plan = planMainViewDroppedFileAttachments({
      paths: ['paper/main.tex', 'paper/main.tex', null, 'build/cache.tmp'],
      allowedExtensions: ALLOWED_EXTENSIONS,
    });

    expect(plan.filesByCategory.input).toEqual(['paper/main.tex']);
    expect(plan.attachedCount).toBe(1);
    expect(plan.rejectedCount).toBe(2);
  });

  it('normalizes extension strings used by manager filters', () => {
    expect(normalizeMainViewFileExtension('FIGURE.PNG')).toBe('png');
    expect(normalizeMainViewFileExtension('.TeX')).toBe('tex');
    expect(normalizeMainViewFileExtension('tex')).toBe('tex');
  });
});
