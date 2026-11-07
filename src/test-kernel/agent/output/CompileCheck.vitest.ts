// Node imports
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { assert, expect, vi } from 'vitest';

// Local imports
import { RunIdSchema } from '@texra-ai/harness/schemas';
import type { CompileLatex2PdfResult } from '@latex/texTools';
import { FakeHost } from '@test/support/testKernel';
import { runCompileCheck } from '@texra/agent/output/compileCheck';

// Local file imports
import {
  compileContext,
  compileFsLayer,
  latexHost,
  outputFile,
} from './compileCheckTestUtils';

// The compiled PDF the fake engine reports; no test seeds it, so artifact
// publication is a no-op — the path only has to be a plausible absolute one.
const COMPILED_PDF = path.join(os.tmpdir(), 'texra-build', 'main.pdf');

const mocks = vi.hoisted(() => ({
  compileLatex2Pdf: vi.fn((): Effect.Effect<CompileLatex2PdfResult> =>
    Effect.succeed({ ok: true, pdfPath: COMPILED_PDF }),
  ),
}));

vi.mock('@latex/texTools', () => ({
  compileLatex2Pdf: mocks.compileLatex2Pdf,
}));

const runId = Schema.decodeUnknownSync(RunIdSchema)('c0e0e1');
const posterTex = path.join(
  '/workspace/.texra/storage/executions',
  runId,
  'r0',
  'poster.tex',
);

// Only `poster.tex` is seeded: the other case's output read fails NotFound
// before compileLatex2Pdf is ever invoked.
layer(
  latexHost({
    [posterTex]:
      '\\documentclass{beamer}\\usetheme{confposter}\\begin{document}\\end{document}',
  }),
  { excludeTestServices: true },
)('runCompileCheck', (it) => {
  // A poster's theme files are bound to its task beside the agent file,
  // not in the workspace; the compile must search there too.
  it.effect("searches the task's bound-file directories", () =>
    Effect.gen(function* () {
      const { roots } = yield* FakeHost;
      const themeDir = '/resources/agents/write';
      const result = yield* runCompileCheck(
        { ...compileContext(roots, runId), inputDirs: [themeDir] },
        0,
        [
          outputFile(
            roots,
            runId,
            path.join('r0', 'poster.tex'),
            'poster.tex',
            0,
          ),
        ],
      );
      assert(result._tag === 'checked');
      expect(result.failures).toHaveLength(0);
      expect(mocks.compileLatex2Pdf).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          extraInputDirs: expect.arrayContaining([themeDir]),
        }),
      );
    }).pipe(Effect.provide(compileFsLayer)),
  );

  it.effect(
    'counts a per-file exception as a failure, never a silent skip',
    () =>
      Effect.gen(function* () {
        const { roots } = yield* FakeHost;
        const result = yield* runCompileCheck(compileContext(roots, runId), 0, [
          outputFile(roots, runId, path.join('r0', 'main.tex'), 'main.tex', 0),
        ]);

        assert(result._tag === 'checked');
        const { failures } = result;
        expect(failures).toHaveLength(1);
        expect(failures[0].displayName).toBe('main.tex');

        // The synthetic excerpt is persisted like a real failure so it stays
        // discoverable on disk, not just in-memory.
        const persisted = yield* Effect.promise(() =>
          readFile(failures[0].log.absolutePath, 'utf-8'),
        );
        expect(persisted).toContain('Compile check errored for main.tex');
      }).pipe(Effect.provide(compileFsLayer)),
  );
});
