import { describe, expect, it } from 'vitest';

import { resolveArxivPaperDirectoryRelative } from '@latex/arxivProcessor';

import { rootCommand } from '../../../packages/cli/src/commands/root';
import {
  LatexCliResultSchema,
  summarizeTexcountOutput,
} from '../../../packages/cli/src/commands/latex';

describe('CLI latex commands', () => {
  it('registers the latex subcommand surface', () => {
    const subCommands = rootCommand.subCommands as Record<
      string,
      { subCommands?: Record<string, unknown> }
    >;
    const latex = subCommands.latex;

    expect(latex).toBeDefined();
    expect(Object.keys(latex.subCommands ?? {}).sort()).toEqual([
      'arxiv',
      'bib',
      'count',
      'deps',
      'diff',
      'figs',
      'fmt',
      'tikz',
    ]);
  });

  it('keeps result json schemas stable across latex subcommands', () => {
    const samples = [
      {
        kind: 'latex-diff',
        oldFile: 'old.tex',
        newFile: 'new.tex',
        outputFile: 'diff.tex',
      },
      {
        kind: 'latex-count',
        files: ['paper.tex'],
        mode: 'separate',
        summary: {
          wordsInText: 10,
          wordsInHeaders: 2,
          wordsOutsideText: 1,
          totalWords: 13,
          sourceCharacters: 100,
        },
        output: 'Words in text: 10',
        errors: [],
      },
      {
        kind: 'latex-arxiv',
        id: '2404.12175',
        path: 'References/2404.12175',
        alreadyExisted: false,
      },
      { kind: 'latex-figs', file: 'paper.tex', paths: ['figures/a.pdf'] },
      { kind: 'latex-deps', file: 'paper.tex', paths: ['sections/intro.tex'] },
      {
        kind: 'latex-bib',
        file: 'paper.tex',
        bibliographyFiles: ['refs.bib'],
        missingBibliographyFiles: [],
        citationKeys: ['key'],
        missingKeys: [],
        entries: { key: '@article{key}' },
      },
      { kind: 'latex-fmt', file: 'paper.tex', formatted: true },
      { kind: 'latex-tikz', file: 'paper.tex', paths: ['build/fig.pdf'] },
    ];

    for (const sample of samples) {
      expect(() => LatexCliResultSchema.parse(sample)).not.toThrow();
    }
  });

  it('summarizes canonical texcount word totals', () => {
    expect(
      summarizeTexcountOutput(`
Words in text: 10
Words in headers: 2
Words outside text: 1
      `),
    ).toEqual({
      wordsInText: 10,
      wordsInHeaders: 2,
      wordsOutsideText: 1,
      totalWords: 13,
      sourceCharacters: null,
    });
  });

  it('keeps custom arxiv destinations id-specific', () => {
    expect(
      resolveArxivPaperDirectoryRelative('2404.12175', {
        into: 'papers',
      }),
    ).toBe('papers/2404.12175');
    expect(
      resolveArxivPaperDirectoryRelative('math/0501234', {
        into: 'papers/',
      }),
    ).toBe('papers/math_0501234');
    expect(resolveArxivPaperDirectoryRelative('2404.12175')).toBe(
      'References/2404.12175',
    );
  });
});
