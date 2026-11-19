import * as assert from 'node:assert';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { describe } from 'vitest';

import {
  collectBibliographyPaths,
  readUncommentedLatex,
} from '@latex/latexParsingUtils';

/** `tex` as the file's readers see it: its comments removed. */
const uncommented = (tex: string) => {
  const texPath = path.join('/workspace', 'main.tex');
  return readUncommentedLatex(texPath).pipe(
    Effect.provide(
      FileSystem.layerNoop({
        readFile: () => Effect.succeed(new TextEncoder().encode(tex)),
      }),
    ),
  );
};

describe('readUncommentedLatex', () => {
  it.effect('drops a command commented out after a line break', () =>
    Effect.gen(function* () {
      // `\\` ends the row; the `%` after it starts a comment.
      const text = yield* uncommented(
        'a & b \\\\% \\input{dropped}\n\\input{kept}',
      );
      assert.strictEqual(text, 'a & b \\\\\\input{kept}');
    }),
  );

  it.effect('keeps what follows a URL with a percent escape', () =>
    Effect.gen(function* () {
      const text = yield* uncommented('\\url{http://a/b%20c} \\input{real}');
      assert.strictEqual(text, '\\url{http://a/b%20c} \\input{real}');
    }),
  );
});

describe('collectBibliographyPaths', () => {
  it('resolves a bibliography directive beside the file', () => {
    const dir = path.join('/workspace', 'chapters');
    assert.deepStrictEqual(
      collectBibliographyPaths(
        dir,
        '\\addbibresource[location=local]{references}',
      ),
      [path.join(dir, 'references.bib')],
    );
  });
});
