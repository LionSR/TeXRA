import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildBetweenRoundDiffSuffix,
  buildLatexdiffAwareFixInstruction,
  detectGeneratedLatexdiffArtifact,
} from '@latex/latexdiff/diffFileNameManager';
import { AbsoluteFS } from '@utils/files';

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
    const base = 'Fix the LaTeX compilation errors in main-diffea268c1.tex.';

    const instruction = await buildLatexdiffAwareFixInstruction(
      base,
      '/paper/main-diffea268c1.tex',
    );

    expect(instruction.startsWith(base)).toBe(true);
    expect(instruction).toContain('latexdiff artifact');
    expect(instruction).toContain('generated from');
  });

  it('treats a bare `_diff` suffix as a real filename when no source exists', async () => {
    vi.spyOn(AbsoluteFS, 'exists').mockResolvedValue(false);
    const base = 'Fix the LaTeX compilation errors in revised_diff.tex.';

    expect(
      await buildLatexdiffAwareFixInstruction(base, '/paper/revised_diff.tex'),
    ).toBe(base);
  });
});
