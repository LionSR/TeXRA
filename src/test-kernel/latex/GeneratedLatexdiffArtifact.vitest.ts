import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildBetweenRoundDiffSuffix,
  buildLatexdiffAwareFixInstruction,
  detectGeneratedLatexdiffArtifact,
  parseVersionControlDiffFilename,
} from '@latex/latexdiff/diffFileNameManager';
import { AbsoluteFS, WorkspaceFS } from '@utils/files';

describe('detectGeneratedLatexdiffArtifact', () => {
  it.each([
    {
      label: 'latexdiff-vc files and infers their source',
      input: '/paper/main-diffea268c1.tex',
      expected: {
        kind: 'versionControlDiff',
        sourcePath: path.join('/paper', 'main.tex'),
      },
    },
    {
      label: 'latexdiff-vc files with a minimum-length abbreviated hash',
      input: '/paper/main-diffea26.tex',
      expected: {
        kind: 'versionControlDiff',
        sourcePath: path.join('/paper', 'main.tex'),
      },
    },
    {
      label: 'between-round TeXRA diff files',
      input: '/paper/output_diffr2r1.tex',
      expected: {
        kind: 'betweenRoundDiff',
        sourcePath: path.join('/paper', 'output.tex'),
      },
    },
    {
      label: 'workspace-side diff files',
      input: '/paper/revised_diff.tex',
      expected: {
        kind: 'workspaceDiff',
        sourcePath: path.join('/paper', 'revised.tex'),
      },
    },
  ])('recognizes $label', ({ input, expected }) => {
    expect(detectGeneratedLatexdiffArtifact(input)).toEqual(expected);
  });

  it.each([
    { label: 'non-generated TeX files', input: '/paper/main.tex' },
    { label: 'non-TeX files', input: '/paper/main-diffabc123.pdf' },
  ])('ignores $label', ({ input }) => {
    expect(detectGeneratedLatexdiffArtifact(input)).toBeNull();
  });
});

describe('parseVersionControlDiffFilename', () => {
  it.each([
    {
      label: '.tex sources',
      input: '/paper/main-diffea268c1.tex',
      expected: {
        sourcePath: path.join('/paper', 'main.tex'),
        commitHash: 'ea268c1',
      },
    },
    {
      label: 'compiled .pdf previews',
      input: '/paper/main-diffea268c1.pdf',
      expected: {
        sourcePath: path.join('/paper', 'main.pdf'),
        commitHash: 'ea268c1',
      },
    },
    {
      label: '.ltx sources',
      input: '/paper/main-diffea268c1.ltx',
      expected: {
        sourcePath: path.join('/paper', 'main.ltx'),
        commitHash: 'ea268c1',
      },
    },
    {
      label: '.latex sources',
      input: '/paper/main-diffea268c1.latex',
      expected: {
        sourcePath: path.join('/paper', 'main.latex'),
        commitHash: 'ea268c1',
      },
    },
    {
      label: 'a minimum-length abbreviated hash',
      input: '/paper/main-diffea26.tex',
      expected: {
        sourcePath: path.join('/paper', 'main.tex'),
        commitHash: 'ea26',
      },
    },
  ])('recognizes $label regardless of extension', ({ input, expected }) => {
    expect(parseVersionControlDiffFilename(input)).toEqual(expected);
  });

  it.each([
    { label: 'plain source files', input: '/paper/main.tex' },
    { label: 'between-round diff files', input: '/paper/output_diffr2r1.tex' },
    { label: 'workspace-side diff files', input: '/paper/revised_diff.tex' },
  ])('ignores $label', ({ input }) => {
    expect(parseVersionControlDiffFilename(input)).toBeNull();
  });
});

describe('buildBetweenRoundDiffSuffix', () => {
  it('builds the `_diffr{newer}r{older}` suffix from numeric rounds', () => {
    expect(buildBetweenRoundDiffSuffix(2, 1)).toBe('_diffr2r1');
  });

  it('accepts string round captures (e.g. from a regex match)', () => {
    expect(buildBetweenRoundDiffSuffix('2', '1')).toBe('_diffr2r1');
  });
});

describe('buildLatexdiffAwareFixInstruction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves the base instruction untouched for a plain source file', async () => {
    const base = 'Fix the LaTeX compilation errors in main.tex.';
    expect(
      await buildLatexdiffAwareFixInstruction(base, '/paper/main.tex'),
    ).toBe(base);
  });

  it('adds latexdiff-artifact guidance when the inferred source exists', async () => {
    vi.spyOn(AbsoluteFS, 'exists').mockResolvedValue(true);
    vi.spyOn(WorkspaceFS, 'relativePath').mockReturnValue('main.tex');
    const base = 'Fix the LaTeX compilation errors in main-diffea268c1.tex.';

    const instruction = await buildLatexdiffAwareFixInstruction(
      base,
      '/paper/main-diffea268c1.tex',
    );

    expect(instruction).toBe(
      [
        base,
        'This file is a latexdiff artifact generated from main.tex.',
        'If an error comes from broken latexdiff markup (\\DIFadd/\\DIFdel or the DIF preamble blocks), repair the markup in place and keep the diff annotations intact.',
        'If an error originates in the original source document, fix the source too so a regenerated diff stays fixed.',
      ].join(' '),
    );
  });

  it('treats a bare `_diff` suffix as a real filename when no source exists', async () => {
    vi.spyOn(AbsoluteFS, 'exists').mockResolvedValue(false);
    const base = 'Fix the LaTeX compilation errors in revised_diff.tex.';

    expect(
      await buildLatexdiffAwareFixInstruction(base, '/paper/revised_diff.tex'),
    ).toBe(base);
  });
});
