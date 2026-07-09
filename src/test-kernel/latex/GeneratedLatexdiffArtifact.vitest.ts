import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildBetweenRoundDiffSuffix,
  detectGeneratedLatexdiffArtifact,
} from '@latex/latexdiff/diffFileNameManager';

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
