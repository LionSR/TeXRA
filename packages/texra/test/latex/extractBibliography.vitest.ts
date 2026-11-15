import * as assert from 'node:assert';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, FileSystem, Layer, PlatformError } from 'effect';
import { describe } from 'vitest';

import { extractBibliographyContext } from '@latex/extractBibliography';

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

  const citationKeysOf = (tex: string) => {
    const texPath = path.join('/workspace', 'main.tex');
    return extractBibliographyContext(texPath).pipe(
      Effect.map((result) => result.citationKeys),
      Effect.provide(filesLayer({ [texPath]: tex })),
    );
  };

  it.effect('drops a citation commented out after a line break', () =>
    Effect.gen(function* () {
      // `\\` ends the row; the `%` after it starts a comment.
      const keys = yield* citationKeysOf(
        'a & b \\\\% \\cite{dropped}\n\\cite{kept}',
      );
      assert.deepStrictEqual(keys, ['kept']);
    }),
  );

  it.effect('keeps a citation after a URL with a percent escape', () =>
    Effect.gen(function* () {
      const keys = yield* citationKeysOf('\\url{http://a/b%20c} \\cite{real}');
      assert.deepStrictEqual(keys, ['real']);
    }),
  );

  it.effect('reads a citation with a space before its optional argument', () =>
    Effect.gen(function* () {
      const keys = yield* citationKeysOf('\\cite [p.~3]{spaced}');
      assert.deepStrictEqual(keys, ['spaced']);
    }),
  );
});
