import * as path from 'node:path';

import { describe, expect, it } from 'vitest';
import { it as effectIt } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';

import {
  buildLatexdiffAwareFixInstruction,
  detectGeneratedLatexdiffArtifact,
  parseVersionControlDiffFilename,
} from '@latex/latexdiff/diffFileNameManager';
import { nodePlatformLayer } from '@test/support/fsTestUtils';

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
  it.each(['tex', 'pdf', 'ltx', 'latex'])(
    'recognizes .%s sources regardless of extension',
    (extension) => {
      expect(
        parseVersionControlDiffFilename(`/paper/main-diffea268c1.${extension}`),
      ).toEqual({
        sourcePath: path.join('/paper', `main.${extension}`),
        commitHash: 'ea268c1',
      });
    },
  );

  it.each([
    { label: 'plain source files', input: '/paper/main.tex' },
    { label: 'between-round diff files', input: '/paper/output_diffr2r1.tex' },
    { label: 'workspace-side diff files', input: '/paper/revised_diff.tex' },
  ])('ignores $label', ({ input }) => {
    expect(parseVersionControlDiffFilename(input)).toBeNull();
  });
});

describe('buildLatexdiffAwareFixInstruction', () => {
  effectIt.live(
    'leaves the base instruction untouched for a plain source file',
    () =>
      Effect.gen(function* () {
        const base = 'Fix the LaTeX compilation errors in main.tex.';
        expect(
          yield* buildLatexdiffAwareFixInstruction(
            base,
            '/paper/main.tex',
            '/paper',
          ),
        ).toBe(base);
      }).pipe(Effect.provide(nodePlatformLayer)),
  );

  effectIt.live(
    'adds latexdiff-artifact guidance when the inferred source exists',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: 'texra-latexdiff-fix-',
        });
        yield* fs.writeFileString(path.join(root, 'main.tex'), '');
        const base =
          'Fix the LaTeX compilation errors in main-diffea268c1.tex.';

        const instruction = yield* buildLatexdiffAwareFixInstruction(
          base,
          path.join(root, 'main-diffea268c1.tex'),
          root,
        );

        expect(instruction).toBe(
          [
            base,
            'This file is a latexdiff artifact generated from main.tex.',
            'If an error comes from broken latexdiff markup (\\DIFadd/\\DIFdel or the DIF preamble blocks), repair the markup in place and keep the diff annotations intact.',
            'If an error originates in the original source document, fix the source too so a regenerated diff stays fixed.',
          ].join(' '),
        );
      }).pipe(Effect.scoped, Effect.provide(nodePlatformLayer)),
  );

  effectIt.live(
    'treats a bare `_diff` suffix as a real filename when no source exists',
    () =>
      Effect.gen(function* () {
        const base = 'Fix the LaTeX compilation errors in revised_diff.tex.';

        expect(
          yield* buildLatexdiffAwareFixInstruction(
            base,
            '/paper/revised_diff.tex',
            '/paper',
          ),
        ).toBe(base);
      }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
