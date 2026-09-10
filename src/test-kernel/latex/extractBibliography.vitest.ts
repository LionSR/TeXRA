import * as assert from 'node:assert';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, vi } from 'vitest';

import {
  extractBibliographyContext,
  loadBibliographyEntries,
  summarizeBibliographyEntries,
} from '@latex/extractBibliography';
import { WorkspaceFS } from '@utils/files/workspaceFS';

const BIB_CONTENT = `@article{alpha,
  title = {Alpha Paper},
}

@book{beta,
  title = {Beta Book},
}`;

describe('extractBibliography helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect('collects bibliography paths and citation keys', () =>
    Effect.gen(function* () {
      const texPath = path.join('chapters', 'main.tex');
      const expectedBibPath = path.join('chapters', 'references.bib');

      vi.spyOn(WorkspaceFS, 'read').mockResolvedValue(`
      % comment
      \\documentclass{article}
      \\addbibresource[location=local]{references}
      Some text \\cite{alpha , beta}
      More citations \\nocite{gamma}
      % \\cite{ignored}
    `);
      vi.spyOn(WorkspaceFS, 'exists').mockImplementation(
        async (file) => file === expectedBibPath,
      );

      const result = yield* extractBibliographyContext(texPath);

      assert.deepStrictEqual(result.bibliographyFiles, [expectedBibPath]);
      assert.deepStrictEqual(result.missingBibliographyFiles, []);
      assert.deepStrictEqual(
        new Set(result.citationKeys),
        new Set(['alpha', 'beta', 'gamma']),
      );
    }),
  );

  it.effect('handles wildcard nocite directives consistently across runs', () =>
    Effect.gen(function* () {
      const texPath = 'paper.tex';
      const expectedBibPath = 'refs.bib';

      vi.spyOn(WorkspaceFS, 'read').mockResolvedValue(`
      % bibliographies
      \\bibliography{refs}
      Intro text
      \\nocite{*}
    `);
      vi.spyOn(WorkspaceFS, 'exists').mockResolvedValue(true);

      const first = yield* extractBibliographyContext(texPath);
      const second = yield* extractBibliographyContext(texPath);

      const expectedKeys = new Set(['*']);

      assert.deepStrictEqual(first.bibliographyFiles, [expectedBibPath]);
      assert.deepStrictEqual(second.bibliographyFiles, [expectedBibPath]);
      assert.deepStrictEqual(new Set(first.citationKeys), expectedKeys);
      assert.deepStrictEqual(new Set(second.citationKeys), expectedKeys);
      assert.deepStrictEqual(second, first);
    }),
  );

  it.effect(
    'marks missing bibliography files and ignores empty citations',
    () =>
      Effect.gen(function* () {
        const texPath = 'paper.tex';

        vi.spyOn(WorkspaceFS, 'read').mockResolvedValue(`
      \\bibliography{bib/one, bib/two.bib, } % trailing comma
      \\cite{first} \\cite{second, third}
    `);
        vi.spyOn(WorkspaceFS, 'exists').mockImplementation(
          async (file) => file === path.join('bib', 'two.bib'),
        );

        const result = yield* extractBibliographyContext(texPath);

        assert.deepStrictEqual(result.bibliographyFiles, [
          path.join('bib', 'two.bib'),
        ]);
        assert.deepStrictEqual(result.missingBibliographyFiles, [
          path.join('bib', 'one.bib'),
        ]);
        assert.deepStrictEqual(
          new Set(result.citationKeys),
          new Set(['first', 'second', 'third']),
        );
      }),
  );

  it.effect(
    'loads requested bibliography entries and reports missing keys',
    () =>
      Effect.gen(function* () {
        vi.spyOn(WorkspaceFS, 'read').mockResolvedValue(BIB_CONTENT);

        const { entries, missingKeys } = yield* loadBibliographyEntries(
          ['references.bib'],
          ['alpha', 'gamma'],
        );

        assert.strictEqual(entries.size, 1);
        // formatBibEntry drops the trailing comma after the last field.
        assert.strictEqual(
          entries.get('alpha'),
          '@article{alpha,\n  title = {Alpha Paper}\n}',
        );
        assert.deepStrictEqual(missingKeys, ['gamma']);

        const formatted = summarizeBibliographyEntries(entries, 5);
        assert.deepStrictEqual(formatted, [
          '@article{alpha,\n  title = {Alpha Paper}\n}',
        ]);
      }),
  );

  it.effect('loads all entries when nocite wildcard is present', () =>
    Effect.gen(function* () {
      vi.spyOn(WorkspaceFS, 'read').mockResolvedValue(BIB_CONTENT);

      const { entries, missingKeys } = yield* loadBibliographyEntries(
        ['references.bib'],
        ['*'],
      );

      assert.strictEqual(entries.size, 2);
      assert.deepStrictEqual(missingKeys, []);
      assert.ok(entries.has('alpha'));
      assert.ok(entries.has('beta'));
    }),
  );
});
