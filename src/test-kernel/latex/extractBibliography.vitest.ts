import * as assert from 'node:assert';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, FileSystem, Layer, PlatformError } from 'effect';
import { describe } from 'vitest';

import {
  extractBibliographyContext,
  loadBibliographyEntries,
  summarizeBibliographyEntries,
} from '@latex/extractBibliography';

const BIB_CONTENT = `@article{alpha,
  title = {Alpha Paper},
}

@book{beta,
  title = {Beta Book},
}`;

/**
 * The files "on disk" for one case. The module reads through the *context*
 * `FileSystem`, so its existence and read answers are served from one map —
 * a listed path exists and reads back its content, anything else is absent.
 */
function filesLayer(
  files: Record<string, string>,
): Layer.Layer<FileSystem.FileSystem> {
  return FileSystem.layerNoop({
    exists: (target) => Effect.succeed(Object.hasOwn(files, target)),
    readFile: (target) => {
      const content = files[target];
      return content === undefined
        ? Effect.fail(
            PlatformError.systemError({
              _tag: 'NotFound',
              module: 'FileSystem',
              method: 'readFile',
              pathOrDescriptor: target,
            }),
          )
        : Effect.succeed(new TextEncoder().encode(content));
    },
  });
}

describe('extractBibliography helpers', () => {
  it.effect('collects bibliography paths and citation keys', () => {
    const texPath = path.join('/workspace', 'chapters', 'main.tex');
    const expectedBibPath = path.join(
      '/workspace',
      'chapters',
      'references.bib',
    );

    return Effect.gen(function* () {
      const result = yield* extractBibliographyContext(texPath);

      assert.deepStrictEqual(result.bibliographyFiles, [expectedBibPath]);
      assert.deepStrictEqual(result.missingBibliographyFiles, []);
      assert.deepStrictEqual(
        new Set(result.citationKeys),
        new Set(['alpha', 'beta', 'gamma']),
      );
    }).pipe(
      Effect.provide(
        filesLayer({
          [texPath]: `
      % comment
      \\documentclass{article}
      \\addbibresource[location=local]{references}
      Some text \\cite{alpha , beta}
      More citations \\nocite{gamma}
      % \\cite{ignored}
    `,
          [expectedBibPath]: '',
        }),
      ),
    );
  });

  it.effect(
    'marks missing bibliography files and ignores empty citations',
    () => {
      const texPath = 'paper.tex';
      const presentBibPath = path.join('bib', 'two.bib');

      return Effect.gen(function* () {
        const result = yield* extractBibliographyContext(texPath);

        assert.deepStrictEqual(result.bibliographyFiles, [presentBibPath]);
        assert.deepStrictEqual(result.missingBibliographyFiles, [
          path.join('bib', 'one.bib'),
        ]);
        assert.deepStrictEqual(
          new Set(result.citationKeys),
          new Set(['first', 'second', 'third']),
        );
      }).pipe(
        Effect.provide(
          filesLayer({
            [texPath]: `
      \\bibliography{bib/one, bib/two.bib, } % trailing comma
      \\cite{first} \\cite{second, third}
    `,
            [presentBibPath]: '',
          }),
        ),
      );
    },
  );

  it.effect(
    'loads requested bibliography entries and reports missing keys',
    () =>
      Effect.gen(function* () {
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
      }).pipe(Effect.provide(filesLayer({ 'references.bib': BIB_CONTENT }))),
  );

  it.effect('loads all entries when nocite wildcard is present', () =>
    Effect.gen(function* () {
      const { entries, missingKeys } = yield* loadBibliographyEntries(
        ['references.bib'],
        ['*'],
      );

      assert.strictEqual(entries.size, 2);
      assert.deepStrictEqual(missingKeys, []);
      assert.ok(entries.has('alpha'));
      assert.ok(entries.has('beta'));
    }).pipe(Effect.provide(filesLayer({ 'references.bib': BIB_CONTENT }))),
  );
});
