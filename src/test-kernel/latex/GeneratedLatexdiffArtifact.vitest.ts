import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { detectGeneratedLatexdiffArtifact } from '@latex/latexdiff/diffFileNameManager';

describe('detectGeneratedLatexdiffArtifact', () => {
  it('recognizes latexdiff-vc files and infers their source', () => {
    expect(
      detectGeneratedLatexdiffArtifact('/paper/main-diffea268c1.tex'),
    ).toEqual({
      kind: 'versionControlDiff',
      sourcePath: path.join('/paper', 'main.tex'),
    });
  });

  it('recognizes between-round TeXRA diff files', () => {
    expect(
      detectGeneratedLatexdiffArtifact('/paper/output_diffr2r1.tex'),
    ).toEqual({
      kind: 'betweenRoundDiff',
      sourcePath: path.join('/paper', 'output.tex'),
    });
  });

  it('recognizes workspace-side diff files', () => {
    expect(detectGeneratedLatexdiffArtifact('/paper/revised_diff.tex')).toEqual(
      {
        kind: 'workspaceDiff',
        sourcePath: path.join('/paper', 'revised.tex'),
      },
    );
  });

  it('ignores non-generated TeX files', () => {
    expect(detectGeneratedLatexdiffArtifact('/paper/main.tex')).toBeNull();
  });

  it('ignores non-TeX files', () => {
    expect(detectGeneratedLatexdiffArtifact('/paper/main-diffabc123.pdf')).toBe(
      null,
    );
  });
});
