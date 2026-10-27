// Node imports
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import type { CompileLatex2PdfResult } from '@latex/texTools';
import type { RunId } from '@shared/schemas';
import { fakePath } from '@test/support/FakePlatform';
import {
  ensureRoundData,
  type OutputState,
} from '@texra/agent/output/outputState';
import { runCompileCheck } from '@texra/agent/output/compileCheck';

// Local file imports
import {
  compileContext,
  compileFsLayer,
  initLatexPlatform,
  outputFile,
} from './compileCheckTestUtils';

// The compiled PDF the fake engine reports; no test seeds it, so artifact
// publication is a no-op — the path only has to be a plausible absolute one.
const COMPILED_PDF = fakePath('build/main.pdf');

const mocks = vi.hoisted(() => ({
  compileLatex2Pdf: vi.fn((): Effect.Effect<CompileLatex2PdfResult> =>
    Effect.succeed({ ok: true, pdfPath: COMPILED_PDF }),
  ),
  hasLatexCompiler: vi.fn((): Effect.Effect<boolean> => Effect.succeed(true)),
}));

vi.mock('@latex/texTools', () => ({
  compileLatex2Pdf: mocks.compileLatex2Pdf,
}));

vi.mock('@latex/latexToolchain', () => ({
  hasLatexCompiler: mocks.hasLatexCompiler,
}));

describe('runCompileCheck', () => {
  it.live('counts a per-file exception as a failure, never a silent skip', () =>
    Effect.gen(function* () {
      const runId = 'compile-exception' as RunId;
      // No file is seeded at the tex path, so the output read fails NotFound
      // before compileLatex2Pdf is ever invoked.
      yield* Effect.promise(() => initLatexPlatform({}));

      const outputState: OutputState = { rounds: new Map() };
      ensureRoundData(outputState, 0).outputs = [
        outputFile(runId, path.join('r0', 'main.tex'), 'main.tex', 0),
      ];

      const result = yield* runCompileCheck(
        compileContext(runId, outputState),
        0,
      );

      const failures = result.failures ?? [];
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
